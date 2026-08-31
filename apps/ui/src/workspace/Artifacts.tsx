import type { ArtifactView } from '../projection/fold'

interface ArtifactsProps {
  artifacts: ArtifactView[]
  blobTexts: Map<string, string>
}

function lineDiff(before: string, after: string): Array<{ op: 'keep' | 'del' | 'add'; text: string }> {
  if (before === after) {
    return before.split('\n').map((text) => ({ op: 'keep', text }))
  }
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ op: 'keep' | 'del' | 'add'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'keep', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ op: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j] })
    j += 1
  }
  return out
}

export function Artifacts({ artifacts, blobTexts }: ArtifactsProps) {
  const byId = new Map(artifacts.map((item) => [item.artifactId, item]))
  const latest = artifacts.filter((item) => !artifacts.some((other) => other.supersedes === item.artifactId))

  return (
    <section className="artifacts" data-testid="artifacts">
      <h2>产物</h2>
      {artifacts.length === 0 ? (
        <p className="empty">还没有产物。成功的 fs.write 会出现在这里。</p>
      ) : (
        <ul>
          {latest.map((item) => {
            const text = blobTexts.get(item.blob.content_hash)
            const previous = item.supersedes ? byId.get(item.supersedes) : undefined
            const previousText = previous ? blobTexts.get(previous.blob.content_hash) : undefined
            const diff =
              text !== undefined && previousText !== undefined ? lineDiff(previousText, text) : null
            return (
              <li key={item.artifactId}>
                <header>
                  <code>{item.path}</code>
                  {item.supersedes ? <span className="muted"> 替换 {item.supersedes}</span> : null}
                </header>
                {diff ? (
                  <pre className="diff" data-testid="artifact-diff">
                    {diff.map((row, index) => (
                      <span key={`${item.artifactId}-${index}`} className={`diff-${row.op}`}>
                        {row.op === 'add' ? '+' : row.op === 'del' ? '-' : ' '}
                        {row.text}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <pre className="preview">{text ?? '正文尚未取回。'}</pre>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
