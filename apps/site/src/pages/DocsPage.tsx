import { useMemo, useState } from 'react';

import type { DocArticle, SiteContent } from '../types.js';
import { SiteIcon } from '../components/icons.js';
import type { NavigateFn } from '../components/Sections.js';

/** B8: 两栏/三栏文档中心壳（职场指南为主，开发者分组默认折叠）。 */
export function DocsPage({
  content,
  docSlug,
  onNavigate,
}: {
  readonly content: SiteContent;
  readonly docSlug?: string | undefined;
  readonly onNavigate: NavigateFn;
}) {
  const { docs } = content;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(docs.groups.map((g) => [g.id, Boolean(g.defaultCollapsed)])),
  );

  const activeArticle: DocArticle = useMemo(() => {
    if (docSlug) {
      const found = docs.articles.find((a) => a.slug === docSlug);
      if (found) return found;
    }
    return docs.articles[0]!;
  }, [docs.articles, docSlug]);

  const normalized = query.trim().toLowerCase();
  const filteredArticles = useMemo(() => {
    if (!normalized) return docs.articles;
    return docs.articles.filter((article) => {
      const hay = [
        article.title,
        article.summary,
        ...article.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...(s.bullets ?? [])]),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(normalized);
    });
  }, [docs.articles, normalized]);

  const activeIndex = docs.articles.findIndex((a) => a.slug === activeArticle.slug);
  const prevArticle = activeIndex > 0 ? docs.articles[activeIndex - 1] : undefined;
  const nextArticle =
    activeIndex >= 0 && activeIndex < docs.articles.length - 1
      ? docs.articles[activeIndex + 1]
      : undefined;

  function toggleGroup(groupId: string) {
    setCollapsed((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }

  return (
    <>
      <section className="ews-docs-banner">
        <div className="ews-container">
          <h1>{docs.title}</h1>
          <p>{docs.subtitle}</p>
          <div className="ews-doc-search">
            <SiteIcon name="search" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={docs.searchPlaceholder}
              aria-label={docs.searchPlaceholder}
            />
          </div>
        </div>
      </section>

      <div className="ews-container">
        <div className="ews-docs-layout">
          <aside className="ews-docs-sidebar" aria-label={docs.title}>
            {filteredArticles.length === 0 ? (
              <p className="ews-provider-note">{docs.emptySearch}</p>
            ) : (
              docs.groups.map((group) => {
                const items = filteredArticles.filter((a) => a.groupId === group.id);
                if (items.length === 0) return null;
                const isGroupCollapsed =
                  !normalized &&
                  Boolean(group.collapsible) &&
                  Boolean(collapsed[group.id]) &&
                  activeArticle.groupId !== group.id;

                return (
                  <div key={group.id}>
                    {group.collapsible ? (
                      <button
                        type="button"
                        className="ews-doc-group-head"
                        aria-expanded={!isGroupCollapsed}
                        onClick={() => toggleGroup(group.id)}
                      >
                        <span>{group.label}</span>
                        <SiteIcon name="chevron-down" />
                      </button>
                    ) : (
                      <div className="ews-doc-group-head">{group.label}</div>
                    )}

                    {!isGroupCollapsed && (
                      <div className="ews-doc-group-list">
                        {items.map((article) => {
                          const active = article.slug === activeArticle.slug;
                          return (
                            <button
                              key={article.slug}
                              type="button"
                              className={active ? 'ews-doc-nav-item is-active' : 'ews-doc-nav-item'}
                              aria-current={active ? 'page' : undefined}
                              onClick={() => onNavigate('docs', article.slug)}
                            >
                              {article.title}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </aside>

          <article className="ews-doc-article">
            <header className="ews-doc-article-head">
              <span className="ews-badge-neutral">{activeArticle.readingTime}</span>
              <h2>{activeArticle.title}</h2>
              <p>{activeArticle.summary}</p>
            </header>

            {activeArticle.sections.map((section) => (
              <section key={section.id} id={section.id} className="ews-doc-section">
                <h3>{section.heading}</h3>
                {section.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {section.bullets && (
                  <ul>
                    {section.bullets.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {section.code && (
                  <pre className="ews-doc-code">
                    <code>{section.code}</code>
                  </pre>
                )}
                {section.callout && (
                  <div className={`ews-callout is-${section.callout.tone}`}>
                    <strong>{section.callout.title}</strong>
                    <p>{section.callout.body}</p>
                  </div>
                )}
              </section>
            ))}

            <nav className="ews-doc-pager" aria-label="Document pagination">
              <div>
                {prevArticle && (
                  <button
                    type="button"
                    className="ews-doc-pager-btn"
                    onClick={() => onNavigate('docs', prevArticle.slug)}
                  >
                    <span>{docs.previousLabel}</span>
                    <strong>{prevArticle.title}</strong>
                  </button>
                )}
              </div>
              <div>
                {nextArticle && (
                  <button
                    type="button"
                    className="ews-doc-pager-btn is-next"
                    onClick={() => onNavigate('docs', nextArticle.slug)}
                  >
                    <span>{docs.nextLabel}</span>
                    <strong>{nextArticle.title}</strong>
                  </button>
                )}
              </div>
            </nav>
          </article>

          <aside className="ews-docs-toc" aria-label={docs.onThisPage}>
            <div className="ews-docs-toc-title">{docs.onThisPage}</div>
            {activeArticle.sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.heading}
              </a>
            ))}
          </aside>
        </div>
      </div>
    </>
  );
}
