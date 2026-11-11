import { Link, Outlet } from "react-router-dom";

export default function Layout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-sky-600 text-sm">◆</span>
          Unity Orchestrator
        </Link>
        <span className="text-xs text-zinc-500">Opus проектирует · Sonnet пишет · Unity проверяет</span>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
