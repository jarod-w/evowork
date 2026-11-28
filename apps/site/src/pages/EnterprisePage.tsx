import { type FormEvent, useState } from 'react';

import { SITE_CONFIG } from '../config.js';
import type { SiteContent } from '../types.js';
import { SiteIcon } from '../components/icons.js';
import type { NavigateFn } from '../components/Sections.js';

interface BookingPayload {
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly teamSize: string;
  readonly interests: readonly string[];
  readonly notes: string;
  readonly locale: string;
  readonly submittedAt: string;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function buildMailtoHref(contactEmail: string, payload: BookingPayload): string {
  const subject = `[EvoWork Enterprise] ${payload.company} — ${payload.name}`;
  const body = [
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Company: ${payload.company}`,
    `Team size: ${payload.teamSize}`,
    `Interests: ${payload.interests.join(', ') || '-'}`,
    `Notes: ${payload.notes || '-'}`,
  ].join('\n');
  return `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** 企业版与预约演示页（含可配置端点 + 兜底联系邮箱的 B9 表单）。 */
export function EnterprisePage({
  content,
  onNavigate,
  leadEndpoint = SITE_CONFIG.leadEndpoint,
  contactEmail = SITE_CONFIG.contactEmail,
}: {
  readonly content: SiteContent;
  readonly onNavigate: NavigateFn;
  readonly leadEndpoint?: string | undefined;
  readonly contactEmail?: string | undefined;
}) {
  const { enterprise } = content;
  const { form } = enterprise.booking;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [teamSize, setTeamSize] = useState(
    form.teamSizeOptions[1] ?? form.teamSizeOptions[0] ?? '',
  );
  const [interests, setInterests] = useState<string[]>([form.interestOptions[0] ?? '']);
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittedPayload, setSubmittedPayload] = useState<BookingPayload | null>(null);
  const [submittedViaPreview, setSubmittedViaPreview] = useState(false);

  function toggleInterest(label: string) {
    setInterests((prev) =>
      prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label],
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim()) {
      setErrorMessage(form.validationName);
      return;
    }
    if (!isValidEmail(email)) {
      setErrorMessage(form.validationEmail);
      return;
    }
    if (!company.trim()) {
      setErrorMessage(form.validationCompany);
      return;
    }
    if (!consent) {
      setErrorMessage(form.validationConsent);
      return;
    }

    const payload: BookingPayload = {
      name: name.trim(),
      email: email.trim(),
      company: company.trim(),
      teamSize,
      interests,
      notes: notes.trim(),
      locale: content.locale,
      submittedAt: new Date().toISOString(),
    };

    setSubmitting(true);
    try {
      if (leadEndpoint) {
        const res = await fetch(leadEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        setSubmittedViaPreview(false);
      } else {
        setSubmittedViaPreview(true);
      }
      setSubmittedPayload(payload);
    } catch {
      setErrorMessage(`${form.errorTitle}：${form.errorFallback} ${contactEmail}`);
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setSubmittedPayload(null);
    setErrorMessage(null);
    setName('');
    setEmail('');
    setCompany('');
    setNotes('');
    setConsent(false);
  }

  return (
    <>
      <section className="ews-hero ews-hero-compact">
        <div className="ews-container">
          <div className="ews-hero-center">
            <div className="ews-hero-eyebrow">
              <SiteIcon name="shield" />
              <span>{enterprise.eyebrow}</span>
            </div>
            <h1 className="ews-hero-title">{enterprise.title}</h1>
            <p className="ews-hero-sub">{enterprise.subtitle}</p>
            <div className="ews-cta-row">
              <a className="ews-btn ews-btn-brand ews-btn-lg" href="#booking">
                <span>{enterprise.primaryCta}</span>
                <SiteIcon name="arrow-right" />
              </a>
              <a className="ews-btn ews-btn-secondary ews-btn-lg" href="#governance">
                <span>{enterprise.secondaryCta}</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* 三种部署形态 */}
      <section className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{enterprise.modesTitle}</h2>
            <p>{enterprise.modesSubtitle}</p>
          </div>

          <div className="ews-modes-grid">
            {enterprise.modes.map((mode) => (
              <div
                key={mode.id}
                className={mode.id === 'private' ? 'ews-mode-card is-featured' : 'ews-mode-card'}
              >
                <div>
                  <span
                    className={mode.id === 'private' ? 'ews-badge-accent' : 'ews-badge-neutral'}
                  >
                    {mode.badge}
                  </span>
                </div>
                <h3>{mode.title}</h3>
                <p>{mode.summary}</p>
                <ul className="ews-check-list">
                  {mode.points.map((pt) => (
                    <li key={pt}>
                      <span className="ews-list-check">
                        <SiteIcon name="check" />
                      </span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 企业治理与内容隔离 */}
      <section id="governance" className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{enterprise.governanceTitle}</h2>
            <p>{enterprise.governanceSubtitle}</p>
          </div>

          <div className="ews-gov-grid">
            {enterprise.governanceCards.map((card) => (
              <div key={card.title} className="ews-gov-card">
                <h3>{card.title}</h3>
                <p>{card.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 诚实的交付透明度表 */}
      <section className="ews-section">
        <div className="ews-container">
          <div className="ews-section-head">
            <h2>{enterprise.statusTitle}</h2>
            <p>{enterprise.statusSubtitle}</p>
          </div>

          <div className="ews-status-table-wrap">
            <table className="ews-status-table">
              <thead>
                <tr>
                  <th>{enterprise.statusColumns[0]}</th>
                  <th>{enterprise.statusColumns[1]}</th>
                  <th>{enterprise.statusColumns[2]}</th>
                </tr>
              </thead>
              <tbody>
                {enterprise.statusRows.map((row) => (
                  <tr key={row.capability}>
                    <td>
                      <strong>{row.capability}</strong>
                    </td>
                    <td>
                      <span
                        className={
                          row.status === 'ready' ? 'ews-badge-accent' : 'ews-badge-neutral'
                        }
                      >
                        {row.statusLabel}
                      </span>
                    </td>
                    <td>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* B9: 预约演示与联系表单 */}
      <section id="booking" className="ews-section">
        <div className="ews-container">
          <div className="ews-booking-split">
            <div className="ews-booking-info">
              <h2>{enterprise.booking.title}</h2>
              <p>{enterprise.booking.subtitle}</p>

              <h3>{enterprise.booking.expectationsTitle}</h3>
              <ul className="ews-check-list">
                {enterprise.booking.expectations.map((item) => (
                  <li key={item}>
                    <span className="ews-list-check">
                      <SiteIcon name="check" />
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <div className="ews-direct-email">
                <span>{enterprise.booking.directEmailLabel}</span>
                <a className="ews-inline-link" href={`mailto:${contactEmail}`}>
                  <SiteIcon name="mail" />
                  <span>{contactEmail}</span>
                </a>
              </div>
            </div>

            <div className="ews-form-card">
              {submittedPayload ? (
                <div className="ews-form-success" role="status">
                  <span className="ews-badge-accent">
                    <SiteIcon name="check" />
                    <span>{form.successTitle}</span>
                  </span>
                  <h3>{form.successTitle}</h3>
                  <p>{submittedViaPreview ? form.successPreviewBody : form.successBody}</p>
                  <div className="ews-cta-row">
                    {submittedViaPreview && (
                      <a
                        className="ews-btn ews-btn-brand"
                        href={buildMailtoHref(contactEmail, submittedPayload)}
                      >
                        <SiteIcon name="mail" />
                        <span>{contactEmail}</span>
                      </a>
                    )}
                    <button
                      type="button"
                      className="ews-btn ews-btn-secondary"
                      onClick={() => onNavigate('download')}
                    >
                      {form.successDownloadCta}
                    </button>
                    <button
                      type="button"
                      className="ews-btn ews-btn-secondary"
                      onClick={handleReset}
                    >
                      {form.successReset}
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  className="ews-form-grid"
                  noValidate
                  onSubmit={(e) => {
                    void handleSubmit(e);
                  }}
                >
                  <div className="ews-field">
                    <label htmlFor="ew-lead-name">{form.nameLabel} *</label>
                    <input
                      id="ew-lead-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={form.namePlaceholder}
                      required
                    />
                  </div>

                  <div className="ews-field">
                    <label htmlFor="ew-lead-email">{form.emailLabel} *</label>
                    <input
                      id="ew-lead-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={form.emailPlaceholder}
                      required
                    />
                  </div>

                  <div className="ews-field">
                    <label htmlFor="ew-lead-company">{form.companyLabel} *</label>
                    <input
                      id="ew-lead-company"
                      type="text"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      placeholder={form.companyPlaceholder}
                      required
                    />
                  </div>

                  <div className="ews-field">
                    <label htmlFor="ew-lead-size">{form.teamSizeLabel}</label>
                    <select
                      id="ew-lead-size"
                      value={teamSize}
                      onChange={(e) => setTeamSize(e.target.value)}
                    >
                      {form.teamSizeOptions.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ews-field is-full">
                    <label>{form.interestsLabel}</label>
                    <div className="ews-chip-group">
                      {form.interestOptions.map((opt) => {
                        const selected = interests.includes(opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            aria-pressed={selected}
                            className={
                              selected ? 'ews-interest-chip is-selected' : 'ews-interest-chip'
                            }
                            onClick={() => toggleInterest(opt)}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="ews-field is-full">
                    <label htmlFor="ew-lead-notes">{form.notesLabel}</label>
                    <textarea
                      id="ew-lead-notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder={form.notesPlaceholder}
                    />
                  </div>

                  <div className="ews-field is-full">
                    <label className="ews-consent-row">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>{form.consentText}</span>
                    </label>
                  </div>

                  {errorMessage && (
                    <div className="ews-field is-full">
                      <div className="ews-form-error" role="alert">
                        {errorMessage}
                      </div>
                    </div>
                  )}

                  <div className="ews-field is-full">
                    <button
                      type="submit"
                      className="ews-btn ews-btn-brand ews-btn-lg ews-btn-block"
                      disabled={submitting}
                    >
                      {submitting ? form.submittingLabel : form.submitLabel}
                    </button>
                    {!leadEndpoint && <p className="ews-form-hint">{form.previewModeNote}</p>}
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
