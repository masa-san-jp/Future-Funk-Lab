# Third-party components

The generated HTML embeds the following libraries, without modifying their sources:

| Component | Version | License | Source |
|---|---|---|---|
| SoundTouchJS | 0.3.0 | LGPL-2.1 | https://github.com/cutterbl/SoundTouchJS |
| @breezystack/lamejs | 1.2.7 | LGPL-3.0 | https://github.com/shijinyu/lamejs |

Full upstream license texts are copied to `dist/licenses/` by `npm run build`. Sources can be obtained reproducibly with `npm ci` using the checked-in lockfile. To replace or modify these libraries, edit their source in `node_modules` (or use an alternative local package dependency) and run `npm run build` to regenerate the HTML. Distribute this source tree, lockfile, notice and license texts alongside the generated application.

Development dependencies: esbuild (MIT) and Playwright (Apache-2.0). They are not embedded in the generated application.
