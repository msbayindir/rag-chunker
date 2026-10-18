# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on
https://github.com/msbayindir/rag-chunker/security/advisories/new. Do not open a public issue for
them. You will get an answer within a week; fixes for confirmed issues ship in a patch release and
the advisory is published once it is out.

## Supported versions

| Version | Supported |
| --- | --- |
| 4.x | yes |
| 3.x | no — please upgrade |

## What the tool does with your data

- Documents, outputs and the cache stay on your machine. Nothing is sent anywhere unless you
  configure a hosted model (`models.*`, `ocr.engine`, `rerank.engine`); then the page text, page
  images or chunks go to that provider only, as the README describes per stage.
- API keys are read from the environment or `.env`, never written to outputs; `manifest.json`
  stores the configuration with keys removed.
- Local models are downloaded from the project's Hugging Face repository (and, for rerankers, from
  their official repositories) and verified against the sha256 recorded in the source before use.
- The inspector UI binds to `127.0.0.1` only; the MCP server speaks over stdio.
