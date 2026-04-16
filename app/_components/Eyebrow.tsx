/**
 * 画面各处用作小标签的 eyebrow 文字：
 * uppercase、字距拉开、mono 字体——是这个仓库的视觉签名之一。
 */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] font-medium uppercase tracking-[0.3em] text-slate-500">
      {children}
    </div>
  );
}
