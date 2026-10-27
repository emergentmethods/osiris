'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { forgetAskNewsKey, loadAskNewsKey, saveAskNewsKey } from '@/lib/asknews-client';

export default function AskNewsKeySheet({ onClose, serverConfigured }: { onClose(): void; serverConfigured: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const section = dialog.current;
    section?.querySelector<HTMLInputElement>('input[type=password]')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab' && section) {
        const controls = [...section.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href]')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      opener?.focus();
    };
  }, []);
  const [saved] = useState(loadAskNewsKey);
  const [key, setKey] = useState(saved.key);
  const [remember, setRemember] = useState(saved.remember);
  const [message, setMessage] = useState('');
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="asknews-key-title" className="glass-panel w-full max-w-md p-5 text-sm text-[var(--text-primary)]" onClick={event => event.stopPropagation()}>
        <div className="flex justify-between"><h2 id="asknews-key-title" className="hud-text">AskNews key</h2><button onClick={onClose} aria-label="Close AskNews key settings">✕</button></div>
        <p className="my-3 text-xs text-[var(--text-muted)]">Your key stays in this browser and is sent to this Osiris instance only in a request header. Save does not turn the source on.</p>
        <label className="block text-xs">API key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} className="mt-1 w-full rounded border border-white/20 bg-black/40 p-2" /></label>
        <label className="my-3 flex gap-2 text-xs"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Remember on this device</label>
        <p className="my-3 text-xs text-[var(--text-muted)]">When enabled, headlines refresh every five minutes with two search calls per poll per reader. Searches and model-selected tools consume your AskNews included usage or wallet. Saving makes no paid validation call.</p>
        <p className="my-3 text-xs text-[var(--text-muted)]">{serverConfigured ? 'This server has an operator fallback key.' : 'Self-hosters can configure ASKNEWS_API_KEY as a fallback.'} On a public instance, any visitor can spend the operator’s credits through model-chosen calls. Your supplied key takes precedence.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="rounded border border-white/25 px-3 py-2" disabled={!key.trim()} onClick={() => { saveAskNewsKey(key, remember); setMessage('Key saved. Turn on AskNews in Layers when ready.'); }}>Save</button>
          <button className="rounded border border-white/25 px-3 py-2" onClick={() => { forgetAskNewsKey(); setKey(''); setRemember(false); setMessage('Key forgotten. Current AskNews reporting removed.'); }}>Forget</button>
          <a href="https://my.asknews.app" target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-primary)] underline">Get a key ↗</a>
        </div>
        <p role="status" className="mt-3 text-xs">{message}</p>
      </section>
    </div>
  );
}
