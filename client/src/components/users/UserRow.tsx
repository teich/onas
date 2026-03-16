import type { SmbUser } from '../../lib/types';

interface UserRowProps {
  user: SmbUser;
  selected: boolean;
  onClick: () => void;
}

export function UserRow({ user, selected, onClick }: UserRowProps) {
  const isDisabled = user.flags.includes('D');
  return (
    <div className={`user-table-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{user.username}</div>
      <div className="td" style={{ color: 'var(--text2)' }}>{user.fullName || '—'}</div>
      <div className="td">
        <span className={`user-status-badge ${isDisabled ? 'disabled' : 'active'}`}>
          {isDisabled ? 'disabled' : 'active'}
        </span>
      </div>
    </div>
  );
}
