import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";
import stylesHref from "./styles.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: stylesHref }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header className="topbar">
          <span className="brand">🏸 球馆预订计费系统</span>
          <nav>
            <a href="/calendar">场地日历</a>
            <a href="/courses">教练班课</a>
            <a href="/members">会员卡</a>
            <a href="/reports">月度报表</a>
            <a href="/admin">节假日/爽约</a>
          </nav>
        </header>
        <main className="container">{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
