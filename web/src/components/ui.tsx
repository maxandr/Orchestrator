import ReactMarkdown from "react-markdown";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Md({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md text-sm leading-relaxed ${className}`}>
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-sky-600 hover:bg-sky-500 text-white",
  secondary: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
  danger: "bg-rose-600/90 hover:bg-rose-500 text-white",
  ghost: "hover:bg-zinc-800 text-zinc-300",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-800 bg-zinc-900/60 ${className}`}>{children}</div>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-md border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">{children}</div>;
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export const inputCls =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none";
