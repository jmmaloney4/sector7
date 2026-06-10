import * as root from "./index.ts";

// @ts-expect-error LiteLLM lives on the ./litellm subpath, not the root barrel
void root.litellm;

// @ts-expect-error Cloud SQL helpers live on the ./cloudsql subpath, not the root barrel
void root.cloudsql;

// @ts-expect-error OnePassword write resource lives on the ./onepassword subpath, not the root barrel
void root.onepassword;

// @ts-expect-error Attic cache/token resources live on the ./attic subpath, not the root barrel
void root.attic;
