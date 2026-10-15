import { render } from "preact";
import { App } from "./app";

// The Worker injects the signed-in login when it serves this page.
const login =
  document.querySelector<HTMLMetaElement>('meta[name="shipshape-login"]')?.content ?? "";

const root = document.querySelector("#root");

if (root) {
  render(<App login={login || "aranlucas"} />, root);
}
