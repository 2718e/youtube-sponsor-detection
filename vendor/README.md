# vendor/

Third-party runtimes this project can drive but does not own.

## kev/

[Kev](https://github.com/jaredpalmer/kev) is a local server that answers the
same typed questions Jev does, over the same wire protocol:

```
POST http://127.0.0.1:8009/v1/systemone
```

Because the protocol is the same, nothing in `src/decisionModel/`, the extension or the
web app changes when you switch between hosted Jev and a local Kev — only
`MODEL_URL` (and, for the extension, the provider fields in the popup).

The extension and scripts default to `http://localhost:8000`; the vendored Kev
listens on 8009 by default, so point them at it (or start it on 8000 with
`KEV_PORT=8000`).

It is not committed here. Clone and build it with:

```sh
npm run local:setup
```

which puts it in `vendor/kev/` (gitignored — remove that line in `.gitignore` to
vendor it into the repository instead). Start it with:

```sh
npm run local:serve          # 127.0.0.1:8009
KEV_MODEL=jaredpalmer/kev-4b npm run local:serve
```

Then point everything at it:

```sh
# web app / scripts
MODEL_URL=http://127.0.0.1:8009 npm start
MODEL_URL=http://127.0.0.1:8009 npm run eval

# extension: popup -> Model provider -> Server URL -> http://127.0.0.1:8009
```

A local model's probabilities are not Jev's, so its confidence bands are not
either. Re-tune them per provider with `npm run eval` and the *Model
calibration* fields under the popup's Advanced section.
