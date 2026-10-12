/** 安装前先展示能力摘要；完整文件明细仍可展开，不改变宿主审计结论。 */
export function AuditFindings({ findings }: { readonly findings: readonly string[] }) {
  const unique = [...new Set(findings)];
  if (unique.length <= 8) return <FindingList findings={unique} />;
  const scripts = unique.filter((finding) => / 会执行命令或脚本。$/.test(finding));
  const network = unique.filter((finding) => / 声明了有限网络访问。$/.test(finding));
  const repeated = new Set([...scripts, ...network]);
  const summary = [
    ...unique.filter((finding) => !repeated.has(finding)),
    ...(scripts.length ? [`发现 ${scripts.length} 项命令或脚本执行提示。`] : []),
    ...(network.length ? [`${network.length} 个文件包含有限网络访问声明。`] : []),
  ];
  return (
    <>
      <FindingList findings={summary} />
      <details className="ew-audit-details">
        <summary>查看完整审计明细（{unique.length} 项）</summary>
        <FindingList findings={unique} />
      </details>
    </>
  );
}

function FindingList({ findings }: { readonly findings: readonly string[] }) {
  return (
    <ul className="ew-catalog-findings">
      {findings.map((finding) => (
        <li key={finding}>{finding}</li>
      ))}
    </ul>
  );
}
