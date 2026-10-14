import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Folder } from 'lucide-react';
import { api } from '../api';
import { EmptyState, ErrorState, RowSkeletons, Sheet } from './ui';

/** Browse pCloud and pick a destination folder. */
export function PcloudFolderPicker({ title, confirmLabel, busy, onPick, onClose }: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onPick: (folder: { folderId: number; name: string }) => void;
  onClose: () => void;
}) {
  const [trail, setTrail] = useState<number[]>([0]);
  const cur = trail[trail.length - 1];
  const status = useQuery({ queryKey: ['pcloud-status'], queryFn: api.pcloudStatus });
  const listing = useQuery({ queryKey: ['pcloud-folders', cur], queryFn: () => api.pcloudFolders(cur), enabled: !!status.data?.connected });
  const here = listing.data?.folder;
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={status.data?.connected ? (
        <button className="btn btn-primary btn-block" disabled={!here || busy} onClick={() => here && onPick({ folderId: here.folderId, name: here.name })}>
          {busy ? 'Working…' : `${confirmLabel}${here ? ` · ${here.name}` : ''}`}
        </button>
      ) : undefined}
    >
      {status.isLoading && <RowSkeletons n={4} />}
      {status.data && !status.data.connected && (
        <EmptyState title="pCloud isn’t connected" action={<Link to="/settings/pcloud" className="btn btn-primary">Connect pCloud</Link>} />
      )}
      {status.data?.connected && (
        <div className="stack gap-8">
          <div className="row gap-8">
            {trail.length > 1 && (
              <button className="icon-btn sm" aria-label="Up one level" onClick={() => setTrail((t) => t.slice(0, -1))}><ChevronLeft size={18} /></button>
            )}
            <span className="caption clamp-1 grow">{here?.path || 'pCloud Drive'}</span>
          </div>
          {listing.isLoading && <RowSkeletons n={4} />}
          {listing.isError && <ErrorState error={listing.error} onRetry={() => listing.refetch()} />}
          {listing.data && (
            <div className="group">
              {listing.data.folders.map((f) => (
                <button key={f.folderId} className="cell" onClick={() => setTrail((t) => [...t, f.folderId])}>
                  <span className="ic cyan"><Folder size={18} /></span>
                  <span className="grow stack"><span className="lbl">{f.name}</span></span>
                  <ChevronRight size={16} color="var(--icon-muted)" />
                </button>
              ))}
              {!listing.data.folders.length && <p className="caption" style={{ padding: 16 }}>No subfolders here. You can save into this folder.</p>}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
