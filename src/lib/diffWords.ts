export interface DiffToken {
  type: 'equal' | 'added' | 'removed';
  text: string;
}

export function computeWordDiff(rawText: string, cleanedText: string): DiffToken[] {
  const rawWords = rawText.trim().split(/(\s+)/);
  const cleanWords = cleanedText.trim().split(/(\s+)/);

  const m = rawWords.length;
  const n = cleanWords.length;

  // Guard against overly large matrices on huge transcripts
  if (m * n > 250000) {
    return [
      { type: 'removed', text: rawText },
      { type: 'added', text: cleanedText },
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (rawWords[i] === cleanWords[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffToken[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (rawWords[i] === cleanWords[j]) {
      result.push({ type: 'equal', text: rawWords[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', text: rawWords[i] });
      i++;
    } else {
      result.push({ type: 'added', text: cleanWords[j] });
      j++;
    }
  }

  while (i < m) {
    result.push({ type: 'removed', text: rawWords[i++] });
  }
  while (j < n) {
    result.push({ type: 'added', text: cleanWords[j++] });
  }

  return result;
}
