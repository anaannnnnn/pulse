import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

/** SPA landing page for pCloud redirects that carry the code/token in the URL (query or #fragment). */
export default function OAuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState('Finishing pCloud sign-in…');
  useEffect(() => {
    api
      .pcloudComplete({ input: location.href })
      .then(() => nav('/settings/pcloud', { replace: true }))
      .catch((e) => setMsg((e as Error).message));
  }, []);
  return (
    <main className="gate">
      <div className="aurora" aria-hidden><i /><i /><i /></div>
      <div className="spinner" />
      <p className="muted">{msg}</p>
      <button className="btn btn-secondary" onClick={() => nav('/settings/pcloud')}>Back to settings</button>
    </main>
  );
}
