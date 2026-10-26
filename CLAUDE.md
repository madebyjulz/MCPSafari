# MCPSafari

## Never leave a second copy of the app registered

Every `MCPSafari.app` that Xcode or `xcodebuild` builds is registered with LaunchServices immediately (`build`, `install` into any `DSTROOT`, and Xcode's Run alike), and deleting the build does not unregister it. Safari then lists another "MCPSafari Extension" and runs every enabled copy, so two extensions connect to the server and calls land on either. This has caused bugs more than once.

- To build and install the app, run `pnpm app:install`. Do not build `MCPSafari.app` into DerivedData, a scratch directory, or anywhere outside `/Applications` and leave it there.
- If you build some other way (for example, to check that it compiles), unregister the result before finishing: `pluginkit -r "<build>/MCPSafari.app/Contents/PlugIns/MCPSafari Extension.appex"` and `lsregister -u "<build>/MCPSafari.app"`, then delete it.
- Afterwards, `pluginkit -m -D -v -i app.eventra.MCPSafari.Extension` must list exactly one copy, under `/Applications/MCPSafari.app`, and `mcp-safari doctor` must pass `extension_duplicates`.

Details: [one copy of the extension](docs/development.md#one-copy-of-the-extension-or-bugs).
