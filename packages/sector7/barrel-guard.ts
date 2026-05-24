import * as root from "./index.ts";

// @ts-expect-error LiteLLM lives on the ./litellm subpath, not the root barrel
void root.litellm;

// @ts-expect-error Cloud SQL helpers live on the ./cloudsql subpath, not the root barrel
void root.cloudsql;
