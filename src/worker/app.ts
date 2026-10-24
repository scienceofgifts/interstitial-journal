import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Type } from '@google/genai';
import { Env, JournalEntryRecord, UserSettingsRecord, D1Database } from './types';

// In-memory fallback stores for when D1 or R2 bindings are pending setup
const memoryEntries = new Map<string, JournalEntryRecord>();
const memorySettings: UserSettingsRecord = {
  theme: 'light',
  defaultCleanupMode: 'clean',
  audioRetention: 'keep',
  transcriptionProvider: 'gemini-3.5-flash-lite',
  accentColor: 'terracotta',
};
const memoryAudio = new Map<string, { buffer: Uint8Array; mimeType: string; durationSec: number }>();

export function getFlashLiteModel(env: Env): string {
  return env.TRANSCRIPTION_MODEL || env.GEMINI_FLASH_LITE_MODEL || 'gemini-3.5-flash-lite';
}

function getGeminiClient(env: Env): GoogleGenAI {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in Cloudflare Worker secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build-interstitial',
      },
    },
  });
}

function formatApiError(err: unknown, model: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
    return `Flash-Lite model API quota exceeded (${model}). Please wait a short moment or try again later. Your recording is preserved locally.`;
  }
  if (message.includes('401') || message.includes('403') || message.includes('API_KEY')) {
    return 'Gemini API key authentication failed. Please check Cloudflare Worker secret configuration.';
  }
  return message;
}

// D1 Data Access Helpers
async function readEntriesFromD1(db: D1Database): Promise<JournalEntryRecord[]> {
  try {
    const result = await db
      .prepare(
        `SELECT id, owner_id, raw_transcription, cleaned_transcription, final_text, cleanup_mode, 
                ambiguity_notes, audio_id, audio_mime_type, audio_duration_sec, date_key, 
                created_at_iso, updated_at_iso 
         FROM journal_entries 
         ORDER BY date_key DESC, created_at_iso DESC`
      )
      .all();

    if (!result.results) return [];
    return result.results.map((r: any) => ({
      id: String(r.id),
      ownerId: String(r.owner_id || 'local'),
      rawTranscription: String(r.raw_transcription || ''),
      cleanedTranscription: String(r.cleaned_transcription || ''),
      finalText: String(r.final_text || ''),
      cleanupMode: r.cleanup_mode || 'none',
      ambiguityNotes: String(r.ambiguity_notes || ''),
      audioId: String(r.audio_id || ''),
      audioMimeType: String(r.audio_mime_type || ''),
      audioDurationSec: Number(r.audio_duration_sec) || 0,
      dateKey: String(r.date_key),
      createdAtIso: String(r.created_at_iso),
      updatedAtIso: String(r.updated_at_iso),
    }));
  } catch (err) {
    console.warn('D1 read error (tables may need migration):', err);
    return Array.from(memoryEntries.values()).sort(
      (a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
    );
  }
}

async function writeEntryToD1(db: D1Database, entry: JournalEntryRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO journal_entries (
         id, owner_id, raw_transcription, cleaned_transcription, final_text, cleanup_mode,
         ambiguity_notes, audio_id, audio_mime_type, audio_duration_sec, date_key,
         created_at_iso, updated_at_iso
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_id = excluded.owner_id,
         raw_transcription = excluded.raw_transcription,
         cleaned_transcription = excluded.cleaned_transcription,
         final_text = excluded.final_text,
         cleanup_mode = excluded.cleanup_mode,
         ambiguity_notes = excluded.ambiguity_notes,
         audio_id = excluded.audio_id,
         audio_mime_type = excluded.audio_mime_type,
         audio_duration_sec = excluded.audio_duration_sec,
         date_key = excluded.date_key,
         updated_at_iso = excluded.updated_at_iso`
    )
    .bind(
      entry.id,
      entry.ownerId,
      entry.rawTranscription,
      entry.cleanedTranscription,
      entry.finalText,
      entry.cleanupMode,
      entry.ambiguityNotes,
      entry.audioId,
      entry.audioMimeType,
      entry.audioDurationSec,
      entry.dateKey,
      entry.createdAtIso,
      entry.updatedAtIso
    )
    .run();
}

async function deleteEntryFromD1(db: D1Database, entryId: string): Promise<void> {
  await db.prepare('DELETE FROM journal_entries WHERE id = ?').bind(entryId).run();
}

async function readSettingsFromD1(db: D1Database, fallbackModel: string): Promise<UserSettingsRecord> {
  try {
    const row = await db.prepare('SELECT data FROM user_settings WHERE key = ?').bind('global').first();
    if (row && row.data) {
      const parsed = JSON.parse(String(row.data));
      return {
        ...memorySettings,
        ...parsed,
        accentColor: ['terracotta', 'midnight', 'sapphire', 'forest'].includes(parsed.accentColor)
          ? parsed.accentColor
          : 'terracotta',
      };
    }
  } catch (err) {
    console.warn('D1 settings read error:', err);
  }
  return { ...memorySettings, transcriptionProvider: fallbackModel };
}

async function writeSettingsToD1(db: D1Database, settings: UserSettingsRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_settings (key, data, updated_at_iso)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         data = excluded.data,
         updated_at_iso = excluded.updated_at_iso`
    )
    .bind('global', JSON.stringify(settings), new Date().toISOString())
    .run();
}

// Create Hono Worker App
export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// 1. Providers and Capabilities
app.get('/api/providers', (c) => {
  const model = getFlashLiteModel(c.env);
  const hasGeminiKey = Boolean(c.env.GEMINI_API_KEY);

  return c.json({
    status: 'ok',
    geminiConfigured: hasGeminiKey,
    modelInUse: model,
    transcriptionProviders: [
      {
        id: model,
        name: `Gemini 3.5 Flash-Lite (${model})`,
        available: hasGeminiKey,
        description: 'High-throughput Flash-Lite model for transcription and cleanup (~500 requests/day quota).',
      },
    ],
    cleanupModel: model,
    storageArchitecture: {
      entries: c.env.DB
        ? 'Cloudflare D1 Relational Database (interstitial-journal-db)'
        : 'Cloudflare D1 Configured (Fallback Mode)',
      audio: c.env.AUDIO_BUCKET
        ? 'Cloudflare R2 Object Storage (interstitial-journal-audio)'
        : 'Cloudflare R2 Configured (Fallback Mode)',
    },
  });
});

// 2. Audio Object Storage (R2 with memory fallback)
app.post('/api/audio', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { audioId, mimeType, dataBase64, durationSec } = body;

    if (!audioId || typeof audioId !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(audioId)) {
      return c.json({ error: 'Invalid audioId format.' }, 400);
    }
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      return c.json({ error: 'Missing audio payload (dataBase64).' }, 400);
    }

    // Convert base64 to Uint8Array
    const binaryString = atob(dataBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    if (bytes.byteLength > 20 * 1024 * 1024) {
      return c.json({ error: 'Audio recording exceeds the 20MB maximum size limit.' }, 413);
    }

    const resolvedMime = mimeType || 'audio/webm';

    if (c.env.AUDIO_BUCKET) {
      await c.env.AUDIO_BUCKET.put(audioId, bytes, {
        customMetadata: {
          mimeType: resolvedMime,
          durationSec: String(durationSec || 0),
          createdAtIso: new Date().toISOString(),
        },
      });
    } else {
      memoryAudio.set(audioId, {
        buffer: bytes,
        mimeType: resolvedMime,
        durationSec: Number(durationSec) || 0,
      });
    }

    return c.json({
      audioId,
      sizeBytes: bytes.byteLength,
      mimeType: resolvedMime,
    });
  } catch (error) {
    console.error('Failed to store audio object:', error);
    return c.json({ error: 'Failed to persist audio recording.' }, 500);
  }
});

app.get('/api/audio/:audioId', async (c) => {
  const audioId = c.req.param('audioId');
  if (!audioId || !/^[a-zA-Z0-9_\-]+$/.test(audioId)) {
    return c.json({ error: 'Invalid audioId.' }, 400);
  }

  // 1. R2 Object Storage
  if (c.env.AUDIO_BUCKET) {
    const rangeHeader = c.req.header('range');
    const object = await c.env.AUDIO_BUCKET.get(audioId, {
      range: rangeHeader ? c.req.raw.headers : undefined,
    });

    if (!object) {
      return c.json({ error: 'Audio recording not found.' }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    if (!headers.get('Content-Type')) {
      headers.set('Content-Type', object.customMetadata?.mimeType || 'audio/webm');
    }

    const status = rangeHeader && object.range ? 206 : 200;
    return new Response(object.body as ReadableStream, {
      status,
      headers,
    });
  }

  // 2. Memory Fallback
  const cached = memoryAudio.get(audioId);
  if (!cached) {
    return c.json({ error: 'Audio recording not found.' }, 404);
  }

  const rangeHeader = c.req.header('range');
  const total = cached.buffer.byteLength;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunk = cached.buffer.slice(start, end + 1);

    return new Response(chunk, {
      status: 206,
      headers: {
        'Content-Type': cached.mimeType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunk.byteLength),
      },
    });
  }

  return new Response(cached.buffer as any, {
    status: 200,
    headers: {
      'Content-Type': cached.mimeType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    },
  });
});

app.delete('/api/audio/:audioId', async (c) => {
  const audioId = c.req.param('audioId');
  if (!audioId) return c.json({ error: 'Invalid audioId.' }, 400);

  if (c.env.AUDIO_BUCKET) {
    await c.env.AUDIO_BUCKET.delete(audioId);
  } else {
    memoryAudio.delete(audioId);
  }

  // Clear audio_id from D1 entry if present
  if (c.env.DB) {
    await c.env.DB.prepare('UPDATE journal_entries SET audio_id = "", audio_mime_type = "" WHERE audio_id = ?')
      .bind(audioId)
      .run()
      .catch(() => {});
  } else {
    for (const [k, v] of memoryEntries.entries()) {
      if (v.audioId === audioId) {
        memoryEntries.set(k, { ...v, audioId: '', audioMimeType: '' });
      }
    }
  }

  return c.json({ deleted: true, audioId });
});

// 3. Dedicated Transcription via Gemini Flash-Lite
app.post('/api/transcribe', async (c) => {
  const model = getFlashLiteModel(c.env);
  try {
    const body = await c.req.json().catch(() => ({}));
    let { audioBase64, audioId, mimeType } = body;

    let base64Data = audioBase64;
    const resolvedMime = (mimeType || 'audio/webm').split(';')[0].trim();

    if (!base64Data && audioId && /^[a-zA-Z0-9_\-]+$/.test(audioId)) {
      if (c.env.AUDIO_BUCKET) {
        const obj = await c.env.AUDIO_BUCKET.get(audioId);
        if (obj) {
          const ab = await obj.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(ab);
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          base64Data = btoa(binary);
        }
      } else if (memoryAudio.has(audioId)) {
        const cached = memoryAudio.get(audioId)!;
        let binary = '';
        for (let i = 0; i < cached.buffer.byteLength; i++) {
          binary += String.fromCharCode(cached.buffer[i]);
        }
        base64Data = btoa(binary);
      }
    }

    if (!base64Data || typeof base64Data !== 'string') {
      return c.json({ error: 'No audio data provided for transcription.' }, 400);
    }

    const ai = getGeminiClient(c.env);
    const audioPart = {
      inlineData: {
        mimeType: resolvedMime,
        data: base64Data,
      },
    };

    const promptText = [
      'Transcribe this spoken journal audio recording accurately into text.',
      'Guidelines:',
      '- Transcribe the recording faithfully, preserving the speaker’s intended words and meaning.',
      '- Add punctuation and sensible sentence boundaries.',
      '- Preserve the speaker’s natural wording, colloquialisms, uncertainty, and qualifications.',
      '- Do NOT summarize, paraphrase, or rewrite the recording during transcription.',
      '- Accurately recognize diverse English accents (including Indian English, British, and North American accents), natural speech rates, proper nouns, places, and technical vocabulary.',
      '- Return the transcript as clean, readable text, not as a summary or analysis of the audio.',
      '- If the audio contains no discernible speech, return "[No discernible speech detected in recording]".',
    ].join('\n');

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [audioPart, { text: promptText }],
      },
    });

    let transcript = (response.text || '').trim();
    if (!transcript && response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          transcript += part.text;
        }
      }
      transcript = transcript.trim();
    }

    if (!transcript) {
      transcript = '[No discernible speech detected in recording]';
    }

    return c.json({
      rawTranscription: transcript,
      providerUsed: model,
    });
  } catch (error) {
    const formatted = formatApiError(error, model);
    console.error('Worker Transcription Error:', formatted);
    return c.json({ error: formatted, recoverable: true }, 500);
  }
});

// 4. AI-Powered Cleanup via Gemini Flash-Lite
app.post('/api/cleanup', async (c) => {
  const model = getFlashLiteModel(c.env);
  try {
    const body = await c.req.json().catch(() => ({}));
    const { rawTranscription, mode = 'clean' } = body;

    if (!rawTranscription || typeof rawTranscription !== 'string' || !rawTranscription.trim()) {
      return c.json({ error: 'Raw transcription text is required for cleanup.' }, 400);
    }

    const ai = getGeminiClient(c.env);
    const isLight = mode === 'light';

    const systemInstruction = isLight
      ? [
          `You are a careful editorial transcription assistant performing LIGHT CLEANUP on a personal voice journal entry using ${model}.`,
          'Rules:',
          '1. Correct likely speech-recognition errors using context, and add sensible punctuation, capitalization, and paragraph boundaries.',
          '2. Strictly preserve the speaker’s natural wording, colloquialisms, and sentence structures.',
          '3. Only remove isolated non-lexical fillers ("um", "uh") when they interrupt sentence flow.',
          '4. Preserve the speaker’s original meaning, uncertainty, personal tone, and qualifications.',
          '5. NEVER invent facts, explanations, or missing ideas that cannot reasonably be inferred.',
          '6. Preserve proper nouns, Indian English expressions, names, and technical terms when uncertain.',
          '7. If any passage or term is genuinely ambiguous, flag it briefly in `ambiguityNotes` rather than confidently guessing.',
        ].join('\n')
      : [
          `You are a careful editorial transcription assistant performing CLEAN AND READABLE refinement on a personal voice journal entry using ${model}.`,
          'Rules:',
          '1. Correct speech-recognition errors using context, and improve punctuation, capitalization, grammar, and readability.',
          '2. Remove unnecessary vocal fillers ("um", "uh", repetitive "like" or "you know"), accidental word repetitions, and false starts where no meaningful content is lost.',
          '3. Improve sentence flow while remaining 100% faithful to the speaker’s original meaning, personal voice, tone, and uncertainty.',
          '4. NEVER turn casual reflections into formal corporate essays. It must sound like the speaker’s authentic thoughts.',
          '5. NEVER add facts or invent words that cannot reasonably be inferred.',
          '6. Preserve names, proper nouns, and technical terms when uncertain.',
          '7. Flag genuinely ambiguous words in `ambiguityNotes` for manual review instead of confidently guessing.',
        ].join('\n');

    const response = await ai.models.generateContent({
      model,
      contents: `Raw voice transcription to clean (${isLight ? 'Light cleanup' : 'Clean and readable'} mode):\n\n${rawTranscription}`,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            cleanedTranscription: {
              type: Type.STRING,
              description: 'The cleaned, faithful journal entry text.',
            },
            ambiguityNotes: {
              type: Type.STRING,
              description:
                'Concise note flagging any genuinely ambiguous words or uncertain terms for manual review, or empty string if clear.',
            },
          },
          required: ['cleanedTranscription', 'ambiguityNotes'],
        },
      },
    });

    const rawJson = (response.text || '{}').trim();
    const parsed = JSON.parse(rawJson);

    return c.json({
      cleanedTranscription: parsed.cleanedTranscription || rawTranscription,
      ambiguityNotes: parsed.ambiguityNotes || '',
      mode: isLight ? 'light' : 'clean',
      modelUsed: model,
    });
  } catch (error) {
    const formatted = formatApiError(error, model);
    console.error('Worker Cleanup Error:', formatted);
    return c.json({ error: formatted, recoverable: true }, 500);
  }
});

// 5. Sample Voice Generation (for hardware-free audio pipeline testing)
app.post('/api/sample-voice', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { promptType = 'reflection' } = body;
    const sampleScripts: Record<string, string> = {
      reflection:
        'Um, quick afternoon note before I step out of the studio in Indiranagar. I was just reviewing the latency numbers on the edge worker deployment, and uh, wait—no, the cold start is actually down to 14 milliseconds now. I think we were overcomplicating the caching layer yesterday. Sometimes stepping away for a walk and a cup of filter coffee makes the architecture way clearer.',
      observation:
        'Walking back from the station just after 6 PM. The light hitting the old brick facade on 4th Street looked extraordinary right after the rain stopped. Um, I want to remember to slow down my mornings this week—less reactive checking of messages, more deliberate thinking before noon.',
    };
    const scriptText = sampleScripts[promptType] || sampleScripts.reflection;

    const ai = getGeminiClient(c.env);
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{ text: scriptText }],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('Could not synthesize voice sample.');
    }

    return c.json({
      audioBase64: base64Audio,
      mimeType: 'audio/wav',
      durationSec: 16,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate voice sample.';
    return c.json({ error: message }, 500);
  }
});

// 6. Persistent Entries CRUD (D1 Database)
app.get('/api/entries', async (c) => {
  if (c.env.DB) {
    const entries = await readEntriesFromD1(c.env.DB);
    return c.json({ entries });
  }

  const entries = Array.from(memoryEntries.values()).sort(
    (a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
  );
  return c.json({ entries });
});

app.post('/api/entries', async (c) => {
  try {
    const payload = (await c.req.json().catch(() => ({}))) as JournalEntryRecord;
    if (!payload || !payload.id || !payload.finalText?.trim()) {
      return c.json({ error: 'Entry id and finalText are required.' }, 400);
    }

    const nowIso = new Date().toISOString();
    const entry: JournalEntryRecord = {
      id: String(payload.id).slice(0, 128),
      ownerId: String(payload.ownerId || 'local').slice(0, 128),
      rawTranscription: String(payload.rawTranscription || '').slice(0, 50000),
      cleanedTranscription: String(payload.cleanedTranscription || '').slice(0, 50000),
      finalText: String(payload.finalText).slice(0, 50000),
      cleanupMode: ['none', 'light', 'clean'].includes(payload.cleanupMode) ? payload.cleanupMode : 'none',
      ambiguityNotes: String(payload.ambiguityNotes || '').slice(0, 5000),
      audioId: String(payload.audioId || '').slice(0, 128),
      audioMimeType: String(payload.audioMimeType || '').slice(0, 64),
      audioDurationSec: Number(payload.audioDurationSec) || 0,
      dateKey: payload.dateKey || nowIso.slice(0, 10),
      createdAtIso: payload.createdAtIso || nowIso,
      updatedAtIso: payload.updatedAtIso || nowIso,
    };

    if (c.env.DB) {
      await writeEntryToD1(c.env.DB, entry);
    } else {
      memoryEntries.set(entry.id, entry);
    }

    return c.json({ entry });
  } catch (error) {
    console.error('Error saving entry:', error);
    return c.json({ error: 'Failed to save journal entry to persistent database.' }, 500);
  }
});

app.put('/api/entries/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const updates = (await c.req.json().catch(() => ({}))) as Partial<JournalEntryRecord>;

    let existing: JournalEntryRecord | undefined;
    if (c.env.DB) {
      const all = await readEntriesFromD1(c.env.DB);
      existing = all.find((e) => e.id === id);
    } else {
      existing = memoryEntries.get(id);
    }

    if (!existing) {
      return c.json({ error: 'Journal entry not found.' }, 404);
    }

    const updatedEntry: JournalEntryRecord = {
      ...existing,
      rawTranscription:
        updates.rawTranscription !== undefined
          ? String(updates.rawTranscription).slice(0, 50000)
          : existing.rawTranscription,
      cleanedTranscription:
        updates.cleanedTranscription !== undefined
          ? String(updates.cleanedTranscription).slice(0, 50000)
          : existing.cleanedTranscription,
      finalText:
        updates.finalText !== undefined && updates.finalText.trim()
          ? String(updates.finalText).slice(0, 50000)
          : existing.finalText,
      cleanupMode:
        updates.cleanupMode && ['none', 'light', 'clean'].includes(updates.cleanupMode)
          ? updates.cleanupMode
          : existing.cleanupMode,
      ambiguityNotes:
        updates.ambiguityNotes !== undefined
          ? String(updates.ambiguityNotes).slice(0, 5000)
          : existing.ambiguityNotes,
      audioId: updates.audioId !== undefined ? String(updates.audioId).slice(0, 128) : existing.audioId,
      audioMimeType:
        updates.audioMimeType !== undefined ? String(updates.audioMimeType).slice(0, 64) : existing.audioMimeType,
      audioDurationSec:
        updates.audioDurationSec !== undefined ? Number(updates.audioDurationSec) : existing.audioDurationSec,
      createdAtIso: existing.createdAtIso,
      dateKey: existing.dateKey,
      updatedAtIso: new Date().toISOString(),
    };

    if (c.env.DB) {
      await writeEntryToD1(c.env.DB, updatedEntry);
    } else {
      memoryEntries.set(id, updatedEntry);
    }

    return c.json({ entry: updatedEntry });
  } catch (error) {
    console.error('Error updating entry:', error);
    return c.json({ error: 'Failed to update journal entry.' }, 500);
  }
});

app.delete('/api/entries/:id', async (c) => {
  try {
    const id = c.req.param('id');
    let targetAudioId = '';

    if (c.env.DB) {
      const all = await readEntriesFromD1(c.env.DB);
      const target = all.find((e) => e.id === id);
      targetAudioId = target?.audioId || '';
      await deleteEntryFromD1(c.env.DB, id);
    } else {
      const target = memoryEntries.get(id);
      targetAudioId = target?.audioId || '';
      memoryEntries.delete(id);
    }

    if (targetAudioId) {
      if (c.env.AUDIO_BUCKET) {
        await c.env.AUDIO_BUCKET.delete(targetAudioId).catch(() => {});
      } else {
        memoryAudio.delete(targetAudioId);
      }
    }

    return c.json({ deleted: true, id });
  } catch (error) {
    console.error('Error deleting entry:', error);
    return c.json({ error: 'Failed to delete journal entry.' }, 500);
  }
});

// 7. Persistent User Settings (D1 Database)
app.get('/api/settings', async (c) => {
  const model = getFlashLiteModel(c.env);
  if (c.env.DB) {
    const settings = await readSettingsFromD1(c.env.DB, model);
    return c.json({ settings });
  }

  return c.json({
    settings: {
      ...memorySettings,
      transcriptionProvider: model,
    },
  });
});

app.put('/api/settings', async (c) => {
  try {
    const model = getFlashLiteModel(c.env);
    const body = await c.req.json().catch(() => ({}));
    const { theme, defaultCleanupMode, audioRetention, transcriptionProvider, accentColor } = body;

    const nextSettings: UserSettingsRecord = {
      theme: ['light', 'dark', 'system'].includes(theme) ? theme : 'light',
      defaultCleanupMode: ['light', 'clean'].includes(defaultCleanupMode) ? defaultCleanupMode : 'clean',
      audioRetention: ['keep', 'delete_after_approval'].includes(audioRetention) ? audioRetention : 'keep',
      transcriptionProvider: transcriptionProvider || model,
      accentColor: ['terracotta', 'midnight', 'sapphire', 'forest'].includes(accentColor)
        ? accentColor
        : 'terracotta',
      updatedAtIso: new Date().toISOString(),
    };

    if (c.env.DB) {
      await writeSettingsToD1(c.env.DB, nextSettings);
    } else {
      Object.assign(memorySettings, nextSettings);
    }

    return c.json({ settings: nextSettings });
  } catch (error) {
    return c.json({ error: 'Failed to save settings.' }, 500);
  }
});

export default app;
