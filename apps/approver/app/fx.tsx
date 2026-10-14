'use client';
/**
 * The animated pieces (Sophie, 13 Oct). Every one renders its final state without JavaScript
 * animation (CSS-only reveals, reduced motion shows the end state at once), so a slow phone or
 * prefers-reduced-motion never hides what a decision depends on.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type AnimationPlaybackControls,
} from 'motion/react';
import { markDifferences } from '../lib/diff';
import { Icon, Mark, type IconName } from './icons';

/* ------------------------------------------------------------------------------------------ */
/* Two addresses in full, the differing characters marked, with a scan on first view.          */

type Group = { start: number; text: string };
const PER_LINE = 5;

/** "0x" + groups of four, five groups a line, so both addresses line up column for column. */
function lines(address: string): Group[][] {
  const groups: Group[] = [{ start: 0, text: address.slice(0, 2) }];
  for (let i = 2; i < address.length; i += 4)
    groups.push({ start: i, text: address.slice(i, i + 4) });
  const out: Group[][] = [groups.slice(0, 1 + PER_LINE)];
  for (let g = 1 + PER_LINE; g < groups.length; g += PER_LINE)
    out.push(groups.slice(g, g + PER_LINE));
  return out;
}

/**
 * The shape of the attack: the same start (0x + four) and end (four) as the address on file, so a
 * glance at the short 0x1234…abcd form sees nothing wrong (the demo's changed address is built so).
 */
function lookAlike(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x !== y && x.slice(0, 6) === y.slice(0, 6) && x.slice(-4) === y.slice(-4);
}

/** Per character: does it differ from `against`? From lib/diff (the tested comparison). */
function differing(value: string, against: string): boolean[] {
  return markDifferences(value, against).flatMap((p) => Array.from(p.text, () => p.differs));
}

function AddressLines({
  value,
  against,
  scan,
  big,
}: {
  value: string;
  against: string;
  scan?: boolean | undefined;
  big?: boolean | undefined;
}) {
  const diff = differing(value, against);
  return (
    <span className={`addr-lines${big ? ' big' : ''}${scan ? ' scan' : ''}`}>
      {lines(value).map((line, li) => {
        const first = line[0]?.start ?? 0;
        return (
          <span key={li} className="addr-line" style={{ '--n0': li * 22 } as CSSProperties}>
            {scan && <span className="scanner" aria-hidden="true" />}
            {line.map((g) => (
              <span key={g.start} className="addr-group">
                {Array.from(g.text, (ch, k) => {
                  const idx = g.start + k;
                  return (
                    <span
                      key={idx}
                      className={`ch${diff[idx] ? ' diff' : ''}`}
                      style={{ '--n': li * 22 + idx - first } as CSSProperties}
                    >
                      {ch}
                    </span>
                  );
                })}
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

type Side = 'file' | 'new';

/** The centrepiece of a changed-address hold or proposal. Tap an address to see it full screen. */
export function AddressCompare({
  onFile,
  other,
  otherLabel,
}: {
  onFile: string;
  other: string;
  otherLabel: string;
}) {
  const [zoom, setZoom] = useState<Side | null>(null);
  const count = differing(other, onFile).filter(Boolean).length;
  const rows: Record<Side, { label: string; note: string; icon: IconName; v: string; a: string }> =
    {
      file: {
        label: 'On file',
        note: 'the only address this account pays',
        icon: 'shieldCheck',
        v: onFile,
        a: other,
      },
      new: { label: otherLabel, note: 'not on file', icon: 'alert', v: other, a: onFile },
    };
  const row = (side: Side, scan: boolean, big: boolean) => {
    const r = rows[side];
    return (
      <div key={side} className={`compare-row ${side}`}>
        <div className="who">
          <Icon name={r.icon} strokeWidth={2} />
          {r.label}
          <em>{r.note}</em>
        </div>
        {big ? (
          <span className="addr-box">
            <AddressLines value={r.v} against={r.a} big />
          </span>
        ) : (
          <button
            type="button"
            className="addr-box"
            onClick={() => {
              setZoom(side);
            }}
            aria-label={`${r.label}: ${r.v}. Tap to enlarge.`}
          >
            <AddressLines value={r.v} against={r.a} scan={scan} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="compare">
      {row('file', true, false)}
      {row('new', true, false)}
      <p className="verdict bad" role="status">
        <Icon name="alert" strokeWidth={2.2} />
        {count} character{count === 1 ? ' differs' : 's differ'}
        {lookAlike(onFile, other) ? ': a look-alike address' : ''}
      </p>
      <p className="hint">Tap an address to enlarge it</p>
      <AnimatePresence>
        {zoom && (
          <Zoom
            onClose={() => {
              setZoom(null);
            }}
          >
            {(zoom === 'file' ? (['file', 'new'] as const) : (['new', 'file'] as const)).map((s) =>
              row(s, false, true),
            )}
          </Zoom>
        )}
      </AnimatePresence>
    </div>
  );
}

function Zoom({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const reduce = useReducedMotion();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <motion.div
      className="zoom"
      role="dialog"
      aria-modal="true"
      aria-label="Both addresses, enlarged"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.15 } }}
      onClick={onClose}
    >
      <motion.div
        className="zoom-body"
        initial={reduce ? false : { scale: 0.94, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        {children}
        <button ref={close} type="button" onClick={onClose}>
          <Icon name="x" /> Close
        </button>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The pipeline: where a payment (or a proposal) is, with real timings when there are some.     */

export type Step = { label: string; state: 'done' | 'active' | 'todo'; time?: string };

export function Track({ steps, tone }: { steps: Step[]; tone: 'accent' | 'warn' | 'ok' | 'bad' }) {
  const reduce = useReducedMotion();
  const reached = steps.reduce((n, s, i) => (s.state === 'todo' ? n : i), 0);
  const progress = steps.length > 1 ? reached / (steps.length - 1) : 0;
  const inset = `${String(50 / steps.length)}%`;
  const current = steps[reached]?.label ?? '';
  const timed = steps.some((s) => s.time !== undefined);
  return (
    <div className={`track ${tone === 'accent' ? '' : tone}`}>
      <div className="track-rail" style={{ left: inset, right: inset }} aria-hidden="true">
        <motion.div
          className="track-fill"
          initial={false}
          animate={{ scaleX: progress }}
          transition={reduce ? { duration: 0 } : { duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ scaleX: progress }}
        />
      </div>
      <ol aria-label={`Where it is: ${current}`}>
        {steps.map((s, i) => (
          <li key={s.label} data-state={s.state} aria-current={i === reached ? 'step' : undefined}>
            <span className="node">
              {s.state === 'done' ? (
                <Icon name={tone === 'bad' && i === reached ? 'x' : 'check'} strokeWidth={2.4} />
              ) : (
                <span className="dot" />
              )}
            </span>
            <span className="step">{s.label}</span>
            {timed && <span className="time">{s.time ?? '\u00a0'}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Press and hold (~1.2 s): deliberate friction before the risky choice's Face ID.              */

const R = 15;
const C = 2 * Math.PI * R;

export function HoldButton({
  label,
  hint,
  disabled,
  onConfirm,
  holdMs = 1200,
}: {
  label: ReactNode;
  hint: string;
  disabled?: boolean | undefined;
  onConfirm: () => void;
  holdMs?: number;
}) {
  const progress = useMotionValue(0);
  const offset = useTransform(progress, (v) => C * (1 - v));
  const anim = useRef<AnimationPlaybackControls | null>(null);
  const [holding, setHolding] = useState(false);

  useEffect(
    () => () => {
      anim.current?.stop();
    },
    [],
  );

  function start() {
    if (disabled || anim.current) return;
    setHolding(true);
    anim.current = animate(progress, 1, {
      duration: holdMs / 1000,
      ease: 'linear',
      onComplete: () => {
        anim.current = null;
        setHolding(false);
        // Android buzzes; iPhone Safari has no vibrate at all.
        if ('vibrate' in navigator) navigator.vibrate(25);
        progress.set(0);
        onConfirm();
      },
    });
  }
  function cancel() {
    if (!anim.current) return;
    anim.current.stop();
    anim.current = null;
    setHolding(false);
    void animate(progress, 0, { duration: 0.25 });
  }
  const isKey = (e: KeyboardEvent) => e.key === 'Enter' || e.key === ' ';

  return (
    <button
      type="button"
      className={`hold${holding ? ' holding' : ''}`}
      disabled={disabled}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (isKey(e) && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (isKey(e)) cancel();
      }}
      onBlur={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <svg className="ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle className="bg" cx="20" cy="20" r={R} />
        <motion.circle
          className="arc"
          cx="20"
          cy="20"
          r={R}
          transform="rotate(-90 20 20)"
          style={{ strokeDasharray: C, strokeDashoffset: offset }}
        />
      </svg>
      <span className="txt">
        <span>{label}</span>
        <small>{holding ? 'Keep holding…' : hint}</small>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* While a real passkey prompt is open (or Monad is answering): what is being signed, in words. */

/** `text` is the screen's own busy line, from the same data as the challenge (handoff rule 8). */
/**
 * A run of prompts shown as one guided flow (judge mode, 13 Oct): which step this is, and which are
 * done. Steps before `done` are finished; step `done` is the one under way.
 */
export type Journey = { steps: string[]; done: number; signing: boolean };

export function Busy({
  text,
  journey,
}: {
  text: string | null;
  journey?: Journey | null | undefined;
}) {
  const reduce = useReducedMotion();
  const signing = journey
    ? journey.signing
    : text !== null && /face id|confirm|passkey|sign/i.test(text);
  const total = journey?.steps.length ?? 0;
  return (
    <AnimatePresence>
      {text !== null && (
        <motion.div
          className="passkey"
          role="status"
          aria-live="polite"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.2 } }}
        >
          <motion.div
            className="passkey-card"
            initial={reduce ? false : { y: 24, scale: 0.96 }}
            animate={{ y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className={`orb${signing ? '' : ' chain'}`}>
              <Icon name={signing ? 'fingerprint' : 'layers'} strokeWidth={1.5} />
            </div>
            <span className="kicker">
              {journey && signing
                ? `STEP ${String(Math.min(journey.done + 1, total))} OF ${String(total)} · YOUR PASSKEY`
                : signing
                  ? 'YOUR PASSKEY'
                  : 'MONAD TESTNET'}
            </span>
            <h2>{signing ? 'Confirm on your phone' : 'Working on Monad'}</h2>
            <p>{text}</p>
            {journey ? (
              <>
                <div className="progress steps" aria-hidden="true">
                  <span style={{ transform: `scaleX(${String(journey.done / total)})` }} />
                </div>
                <ol className="journey" aria-label="Setting up your test account">
                  {journey.steps.map((s, i) => (
                    <li
                      key={s}
                      className={i < journey.done ? 'done' : i === journey.done ? 'now' : undefined}
                      aria-current={i === journey.done ? 'step' : undefined}
                    >
                      <span className="dot" aria-hidden="true">
                        {i < journey.done ? <Icon name="check" strokeWidth={2.5} /> : i + 1}
                      </span>
                      <span>
                        {s}
                        {i < journey.done ? <span className="sr-only"> (done)</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="progress" aria-hidden="true" />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* A decision made: a mark that draws itself, and the transaction's hash typing out.            */

export function Decided({
  tone,
  title,
  detail,
  hash,
  children,
}: {
  tone: 'ok' | 'bad' | 'warn';
  title: string;
  detail?: string | undefined;
  hash?: string | null | undefined;
  children?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const full = hash ?? '';
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (reduce) {
      setShown(full.length);
      return;
    }
    setShown(0);
    let i = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const delay = setTimeout(() => {
      timer = setInterval(() => {
        i += 2;
        setShown(i);
        if (i >= full.length) clearInterval(timer);
      }, 16);
    }, 700);
    return () => {
      clearTimeout(delay);
      clearInterval(timer);
    };
  }, [full, reduce]);

  const draw = (delay: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { pathLength: 0 },
          animate: { pathLength: 1 },
          transition: { duration: 0.5, delay, ease: [0.2, 0.8, 0.2, 1] as const },
        };

  return (
    <section className={`card done ${tone}`} role="status">
      <svg className="mark" width="84" height="84" viewBox="0 0 88 88" aria-hidden="true">
        <motion.circle cx="44" cy="44" r="40" {...draw(0)} />
        <motion.path
          d={
            tone === 'ok'
              ? 'M27 45l12 12 23-26'
              : tone === 'bad'
                ? 'M31 31l26 26M57 31L31 57'
                : 'M44 26v22M44 60v1'
          }
          {...draw(0.35)}
        />
      </svg>
      <h2>{title}</h2>
      {detail && <p className="muted small">{detail}</p>}
      {full && (
        <code className="typed" aria-label={`Transaction ${full}`}>
          {full.slice(0, shown)}
          {shown < full.length && <span className="caret" />}
        </code>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Home: the orbit (decoration only, so it says no numbers).                                   */

export function Orbit() {
  return (
    <div className="orbit" aria-hidden="true">
      <span className="ring" />
      <span className="ring" />
      <span className="core">
        <Mark id="orbit" />
      </span>
      <span className="chip a">
        <Icon name="file" /> INVOICE IN
      </span>
      <span className="chip b">
        <Icon name="check" /> MATCHES · PAID
      </span>
      <span className="chip c">
        <Icon name="alert" /> CHANGED · HELD
      </span>
    </div>
  );
}

/** A skeleton line while something loads: a sweep, never a spinner. */
export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}
