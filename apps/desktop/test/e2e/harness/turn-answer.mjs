/** Completed assistant delivery in the latest public turn; a Stop acknowledgement does not replace it. */
export function completedTurnAnswer(items) {
  const turn = items.findLast((item) => typeof item._turnId === 'string')?._turnId;
  const start =
    turn === undefined
      ? Math.max(
          0,
          items.findLastIndex((item) => item.type === 'userMessage'),
        )
      : 0;
  return items
    .slice(start)
    .filter(
      (item) =>
        item.type === 'agentMessage' &&
        item.completed !== false &&
        item.phase !== 'commentary' &&
        (turn === undefined || item._turnId === turn),
    )
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}
