# Terminalz for iPhone and iPad

A small SwiftUI client targeting iOS/iPadOS 17+. Uses Apple's standard dark lists,
forms, navigation bars, SF Symbols, and adaptive three-column navigation. No Swift
package dependencies. On iPhone the columns collapse into a navigation stack.

## Build

Install Xcode and XcodeGen, then from this directory:

```sh
brew install xcodegen
xcodegen generate
open Terminalz.xcodeproj
```

Select your signing team and a unique bundle identifier in Xcode, choose an iPhone
or iPad, and Run. Generated Xcode project files and signing configuration stay local.
For a simulator build after generation:

```sh
xcodebuild -project Terminalz.xcodeproj -scheme Terminalz -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Deploy the matching web server revision first: the client requires its authenticated
`/native/terminal` route. Enter the server's **HTTPS origin**, for example
`https://terminals.example.com`. A valid, device-trusted certificate is required;
there are no ATS bypasses. The native form supports password and passwordless
trusted-network servers. OAuth-only servers are not supported in this first version;
they require a native browser sign-in handoff. There is no new authentication API
or agent-token storage in the app.

## Architecture and limits

- SwiftUI renders machine/session groups, spaces, tabs, status indicators, and settings.
  Native ids, names, ordering and Herdr dot/symbol conventions come from inventory.
- One nonpersistent WebKit terminal view reuses xterm, mirrored splits, terminal
  input controls, binary streaming, bounded scrollback, and checkpoint/reconnect
  handling. The terminal renderer is web-based; the navigation shell is native Swift.
- The native surface forces dark and low-data mode, including on large iPads.
- The native status socket applies compact status/focus patches. Structural changes
  fetch inventory again. Backgrounding closes it and destroys the terminal view;
  foregrounding reconciles inventory and obtains a fresh terminal checkpoint.
- Only the server address is saved. Cookies, inventory, and WebKit data are in memory;
  reconnect/sign in after terminating the app. Disconnect clears the local session.
- This first client browses and attaches to existing sessions. Session creation,
  machine enrollment, and administration remain in the web client.

## Verification before distributing

Build with Xcode, then check real iPhone/iPad keyboard appearance, hardware keyboard,
rotation, iPad Split View/Stage Manager, network handoff, background/foreground,
expired authentication, server switching, unavailable/deleted tabs, mirrored splits,
VoiceOver, Dynamic Type, and memory after repeatedly switching tabs. No App Store signing, icons,
or distribution setup is included. A macOS environment with command-line tools only
cannot typecheck SwiftUI/WebKit or run these device checks.
