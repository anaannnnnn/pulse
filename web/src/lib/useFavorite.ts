import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';

export function useFavorite() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.setFavorite,
    onSuccess: (_d, v) => {
      qc.invalidateQueries();
      toast(v.on ? (v.list === 'watchlist' ? 'Added to watchlist' : 'Added to favorites') : v.list === 'watchlist' ? 'Removed from watchlist' : 'Removed from favorites', 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
}
