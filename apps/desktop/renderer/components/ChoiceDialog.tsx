import { useEffect, useMemo, useRef } from 'react';

import type { PermissionRequest } from '@shipyard/shared';

interface Props {
  request: PermissionRequest;
  onAnswer: (optionIndex: number) => void;
}

/**
 * Everything Claude blocks on: permission to change a file, a question about
 * what the user wants, and the review step that submits those answers.
 *
 * These share mechanics and share nothing else. Titling a question "Claude
 * wants to make a change" would be nonsense, so the copy switches on `kind`
 * while the keyboard handling and option list stay identical.
 *
 * PRODUCT.md principle 3: the real choices are shown as the CLI offers them,
 * never collapsed and never pre-answered. Focus is trapped, and Escape answers
 * rather than dismisses, because the CLI is blocked until we reply and a
 * silently closed dialog would hang the session. That exact hang shipped once.
 */
export function ChoiceDialog({ request, onAnswer }: Props): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const copy = useMemo(() => describe(request), [request]);

  const preferred =
    request.options.find((o) => o.kind === 'allow-once') ??
    request.options.find((o) => o.kind === 'neutral') ??
    request.options[0];
  const escapeTarget = request.options.find((o) => o.kind === 'deny');

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusables = (): HTMLElement[] =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])') ?? [])
        .filter((el) => !el.hasAttribute('disabled'));

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (escapeTarget) onAnswer(escapeTarget.index);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [escapeTarget, onAnswer]);

  const answered = request.steps?.filter((s) => !s.isSubmit && s.done).length ?? 0;
  const total = request.steps?.filter((s) => !s.isSubmit).length ?? 0;

  return (
    <div className="backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        ref={dialogRef}
      >
        <div className="dialog-head">
          {total > 0 && (
            <div className="steps" aria-label={`Question ${Math.min(answered + 1, total)} of ${total}`}>
              {request.steps
                ?.filter((s) => !s.isSubmit)
                .map((step, i) => (
                  <span
                    key={step.label}
                    className={`step${step.done ? ' step-done' : ''}${
                      !step.done && i === answered ? ' step-current' : ''
                    }`}
                    title={step.label}
                  />
                ))}
              <span className="text-xs muted">
                {request.kind === 'review'
                  ? 'Last step'
                  : `Question ${Math.min(answered + 1, total)} of ${total}`}
              </span>
            </div>
          )}

          <h2 className="dialog-title" id="choice-title">
            {copy.title}
          </h2>
          {copy.subtitle && (
            <p className="text-sm muted" style={{ marginTop: 'var(--space-1)' }}>
              {copy.subtitle}
            </p>
          )}
        </div>

        {copy.detail && (
          <div className="dialog-body">
            <pre className="log" style={{ marginTop: 0 }} tabIndex={0}>
              {copy.detail}
            </pre>
          </div>
        )}

        <div className="dialog-foot">
          {request.options.map((option) => (
            <button
              key={option.index}
              className={`btn choice${option.index === preferred?.index ? ' btn-primary' : ''}`}
              onClick={() => onAnswer(option.index)}
            >
              <span className="choice-label">{option.label}</span>
              {option.description && <span className="choice-note">{option.description}</span>}
              {!option.description && option.kind === 'allow-always' && (
                <span className="choice-note">
                  Claude won&apos;t ask again for this kind of change until you close the app.
                </span>
              )}
              {!option.description && option.kind === 'deny' && request.kind === 'permission' && (
                <span className="choice-note">
                  Claude will skip this and tell you why it wanted to.
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Copy {
  title: string;
  subtitle?: string;
  detail?: string;
}

function describe(request: PermissionRequest): Copy {
  const { headline, body } = splitQuestion(request.question);

  switch (request.kind) {
    case 'question':
      // The header IS the question. Anything else would be us talking over it.
      return { title: headline, ...(body ? { detail: body } : {}) };

    case 'review':
      return {
        title: 'Ready to start building?',
        subtitle: "Here's what you chose. Claude will use these answers.",
        ...(body ? { detail: body } : {}),
      };

    case 'permission':
      return {
        title: headline || 'Claude wants to make a change',
        subtitle: 'Nothing changes on your computer until you choose.',
        ...(body ? { detail: body } : {}),
      };

    default:
      return { title: headline || 'Claude needs an answer', ...(body ? { detail: body } : {}) };
  }
}

/**
 * The CLI packs the question, the affected file, and a preview of the change
 * into one block separated by dashed rules. Pull out the line that is actually
 * the question; the rest is context for the detail pane.
 */
function splitQuestion(question: string): { headline: string; body: string } {
  const lines = question.split('\n');
  const isRule = (l: string): boolean => /^[╌─-]{10,}\s*$/.test(l.trim());

  const askIndex = lines.findIndex((l) => /^\s*(do you want to|ready to submit)/i.test(l));
  if (askIndex !== -1) {
    return {
      headline: (lines[askIndex] ?? '').trim(),
      body: lines
        .filter((_, i) => i !== askIndex)
        .filter((l) => !isRule(l))
        .join('\n')
        .trim(),
    };
  }

  // Otherwise the first meaningful line is the question and the rest is context.
  const firstIndex = lines.findIndex((l) => l.trim().length > 0 && !isRule(l));
  if (firstIndex === -1) return { headline: '', body: '' };
  return {
    headline: (lines[firstIndex] ?? '').trim(),
    body: lines
      .slice(firstIndex + 1)
      .filter((l) => !isRule(l))
      .join('\n')
      .trim(),
  };
}
