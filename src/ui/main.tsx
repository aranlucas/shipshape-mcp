import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "preact";
import { App } from "./app";
import { createQueryClient } from "./queries";

// The Worker injects the signed-in login when it serves this page.
const login =
  document.querySelector<HTMLMetaElement>('meta[name="shipshape-login"]')?.content ?? "";

const root = document.querySelector("#root");

if (root) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <App login={login || "aranlucas"} />
    </QueryClientProvider>,
    root,
  );
}
