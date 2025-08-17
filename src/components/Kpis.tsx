type Props = {
  title: string;
  value: string | number;
  sub?: string;
  onClick?: () => void;
};

export function Kpi({ title, value, sub, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-2xl border border-slate-800 bg-slate-900/60 p-5 hover:bg-slate-900 transition"
    >
      <div className="text-xs text-slate-400">{title}</div>
      <div className="text-3xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-slate-400 text-xs">{sub}</div>}
    </button>
  );
}
