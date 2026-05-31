# termag macOS Usability Improvements

## 🎯 Overview

Brainstorming usability improvements for the macOS terminal and menu bar experience.

---

## 📱 Menu Bar App Improvements

### 1. Status Indicators

- **Agent Connection Status**
  - Green dot: Agent online and connected
  - Yellow dot: Agent online but broker disconnected
  - Red dot: Agent offline
  - Click to see connection details and reconnect button

- **Active Session Indicator**
  - Show current project name in menu bar
  - Show current branch name (git)
  - Show number of active tabs/sessions
  - Click to switch between projects

- **Background Task Status**
  - Show spinner when long-running command in progress
  - Show notification when command completes
  - Quick access to view command output

### 2. Quick Actions Menu

- **Project Actions**
  - "Open Terminal" for current project
  - "New Session" for current project
  - "Open in Browser" for web app
  - "Run Last Command"
  - "Open File Explorer"

- **Git Quick Actions**
  - "Git Status" - Quick peek
  - "Git Pull" - One-click pull
  - "Git Push" - One-click push
  - "Show Current Branch"
  - "View Recent Commits"

- **Session Management**
  - "Switch to Previous Session"
  - "Close All Sessions"
  - "Pin Current Session"
  - "Export Session State"

### 3. System-Wide Keyboard Shortcuts

- `Cmd+Shift+T` - Open new terminal session for current project
- `Cmd+Shift+K` - Open command palette
- `Cmd+Shift+G` - Quick git status
- `Cmd+Shift+P` - Quick pull
- `Cmd+Shift+U` - Quick push
- `Cmd+Shift+L` - Open last closed session
- `Cmd+Shift+O` - Open file (project search)
- `Cmd+Shift+F` - Find in files (grep)

### 4. Notification Integration

- **Command Completion Notifications**
  - Notify when long-running command completes
  - Show exit code and first line of output
  - Click to view full output

- **Git Notifications**
  - Notify on push/pull completion
  - Notify on merge conflicts
  - Notify on rebase completion

- **Agent Notifications**
  - Notify when agent goes offline
  - Notify when agent reconnects
  - Notify on critical errors

### 5. Spotlight/Alfred Integration

- **Spotlight Plugin**
  - Search for projects: "termag project myapp"
  - Search for sessions: "termag session main"
  - Quick commands: "termag git status"
  - Open terminal: "termag open myapp"

- **Alfred Workflow**
  - Same as Spotlight but with Alfred workflow
  - Show project list with status indicators
  - Quick switch between projects
  - Execute commands without opening terminal

### 6. Touch Bar Support (MacBooks with Touch Bar)

- **Touch Bar Widgets**
  - Project switcher (scrollable list)
  - Quick git actions (pull, push, status)
  - Session tabs (horizontal scroll)
  - Quick commands (customizable)
  - Connection status indicator

- **Dynamic Touch Bar**
  - Show git branch when in git repo
  - Show command history when typing
  - Show active sessions
  - Context-sensitive actions

### 7. Control Center Widget (macOS 13+)

- **Control Center Module**
  - Quick toggle for terminal visibility
  - Project switcher
  - Agent connection status
  - Quick access to web app

---

## 💻 Terminal Integration

### 1. iTerm2 Integration

- **Shell Integration**
  - Detect iTerm2 and use shell integration
  - Use iTerm2's native tmux integration
  - Leverage iTerm2's escape sequences for colors, marks
  - Use iTerm2's semantic history (Cmd+Shift+H)

- **Profile Management**
  - Auto-create iTerm2 profiles for each project
  - Project-specific color schemes
  - Project-specific fonts
  - Project-specific window arrangements

- **Trigger Integration**
  - iTerm2 triggers for command palette (Cmd+K)
  - Triggers for git operations
  - Triggers for file operations
  - Custom triggers per project

### 2. Terminal.app Integration

- **Profile Management**
  - Create Terminal.app profiles for projects
  - Auto-switch profile based on CWD
  - Project-specific settings

- **Window Management**
  - Save/restore window arrangements
  - Tab management integration
  - Split pane support

### 3. Context-Aware Menus

- **Right-Click Context Menu**
  - "Open in termag" (file/directory)
  - "Git Status" (in git repo)
  - "Quick Commit" (in git repo)
  - "Open File in termag" (file)
  - "Run Script" (executable file)

### 4. Quick Open from Terminal

- **Terminal Command**
  - `termag open [file]` - Open file in termag
  - `termag git [command]` - Run git command with UI
  - `termag search [query]` - Open search dialog
  - `termag session [name]` - Switch to session
  - `termag new` - Create new session

- **Shell Integration**
  - Auto-detect current directory
  - Auto-detect current project
  - Auto-detect git branch
  - Context-aware suggestions

### 5. Terminal Session Restoration

- **Session Persistence**
  - Save terminal scrollback on exit
  - Restore scrollback on reconnect
  - Restore command history
  - Restore working directory
  - Restore environment variables

### 6. Color Scheme Management

- **Dynamic Color Schemes**
  - Auto-switch color scheme based on project
  - Auto-switch based on git branch (e.g., red for main, green for feature)
  - Auto-switch based on environment (dev/staging/prod)
  - User-customizable rules

- **Theme Sync**
  - Sync with macOS appearance (dark/light)
  - Sync with terminal app theme
  - Per-project theme overrides

### 7. Font Size Controls

- **Quick Font Scaling**
  - Menu bar shortcut to increase/decrease font size
  - Per-project font size
  - Remember font size per session
  - Zoom in/out with keyboard shortcuts

---

## 🤖 Agent Improvements

### 1. Auto-Reconnection

- **Network Change Detection**
  - Detect network changes (Wi-Fi, Ethernet, VPN)
  - Auto-reconnect to broker on network change
  - Exponential backoff for reconnection attempts
  - Notify user of reconnection status

- **Graceful Reconnection**
  - Preserve session state during reconnect
  - Resume command output after reconnect
  - Don't lose scrollback during reconnect
  - Show reconnection progress

### 2. Better Error Reporting

- **Error Notifications**
  - Show errors in menu bar
  - Show errors in notification center
  - Provide actionable error messages
  - Link to troubleshooting docs

- **Error Recovery**
  - Auto-retry on transient errors
  - Suggest fixes for common errors
  - One-click error resolution (when possible)
  - Error history with timestamps

### 3. Local Command History Sync

- **History Persistence**
  - Save command history locally
  - Sync history across sessions
  - History search (Cmd+R style)
  - History per project

- **Smart History**
  - Deduplicate commands
  - Rank commands by frequency
  - Context-aware suggestions
  - Auto-complete based on history

### 4. Background Task Notifications

- **Long-Running Commands**
  - Notify when command runs > 30s
  - Show progress indicator in menu bar
  - Allow to run in background
  - Quick access to output

- **Background Jobs**
  - Run commands in background without blocking
  - List background jobs
  - Bring to foreground
  - Kill background jobs

### 5. Resource Usage Monitoring

- **CPU/Memory Usage**
  - Show agent CPU usage in menu bar
  - Show agent memory usage in menu bar
  - Alert on high resource usage
  - Resource usage history

- **Session Monitoring**
  - Show number of active sessions
  - Show session resource usage
  - Alert on runaway sessions
  - Session cleanup suggestions

---

## 🚀 Workflow Improvements

### 1. Project Context Awareness

- **Automatic Project Detection**
  - Detect current project from CWD
  - Detect project from git remote
  - Detect project from package.json
  - Detect project from .termag/config.json

- **Context-Aware UI**
  - Show current project in menu bar
  - Show current git branch
  - Show current environment
  - Context-sensitive commands

### 2. Quick Project Switching

- **Project Switcher**
  - Cmd+P to open project switcher
  - Fuzzy search projects
  - Show project status (online/offline)
  - Quick access to recent projects

- **Project Bookmarks**
  - Pin favorite projects
  - Organize projects in folders
  - Quick access to pinned projects
  - Project notes/metadata

### 3. Session Templates

- **Pre-Configured Layouts**
  - Save session layout as template
  - Load template for new session
  - Template per project
  - Share templates across projects

- **Session Presets**
  - Pre-configure environment variables
  - Pre-configure aliases
  - Pre-configure startup commands
  - Pre-configure window arrangement

### 4. Environment Variable Management

- **Environment Profiles**
  - Per-project environment variables
  - Per-session environment variables
  - Quick switch between profiles
  - Environment variable editor

- **Secret Management**
  - Secure storage for secrets
  - Inject secrets into sessions
  - Secret rotation
  - Secret audit log

### 5. SSH Host Management

- **SSH Configuration**
  - Manage SSH hosts in UI
  - Auto-generate SSH config
  - SSH key management
  - SSH connection testing

- **SSH Quick Connect**
  - Quick connect to saved hosts
  - SSH session management
  - SSH tunnel management
  - SSH agent forwarding

### 6. Git Operations from Menu Bar

- **Quick Git Actions**
  - Git status from menu bar
  - Quick commit from menu bar
  - Quick push/pull from menu bar
  - Branch switcher from menu bar

- **Git Status Display**
  - Show git status in menu bar
  - Show uncommitted changes count
  - Show branch name
  - Show unpushed commits count

---

## 🔗 System Integration

### 1. macOS Notification Center

- **Notification Categories**
  - Command completion
  - Git operations
  - Agent status
  - Errors/warnings

- **Notification Actions**
  - "View Output" button
  - "Reconnect" button
  - "Retry" button
  - "Dismiss" button

### 2. Quick Look Integration

- **Preview Files**
  - Quick Look for files from file explorer
  - Quick Look for command output
  - Quick Look for git diffs
  - Quick Look for logs

### 3. Finder Context Menu

- **Context Menu Items**
  - "Open in termag" (directory)
  - "Open File in termag" (file)
  - "Git Status" (in git repo)
  - "Quick Commit" (in git repo)

### 4. Share Sheet Integration

- **Share Actions**
  - Share file path to termag
  - Share git commit to termag
  - Share command to termag
  - Share URL to termag (to clone)

### 5. Drag and Drop

- **Drag to Terminal**
  - Drag file to terminal to open
  - Drag directory to terminal to cd
  - Drag git repo to terminal to clone
  - Drag URL to terminal to clone

### 6. Universal Control

- **Cross-Device**
  - Use iPad as secondary display for terminal
  - Use iPhone for notifications
  - Sync clipboard across devices
  - Continuity for sessions

---

## 🎨 UI/UX Improvements

### 1. Menu Bar UI

- **Clean Design**
  - Minimal menu bar icon
  - Collapsible menu sections
  - Keyboard navigation (arrow keys)
  - Visual indicators (icons, colors)

- **Customizable Menu**
  - Show/hide menu items
  - Reorder menu items
  - Add custom menu items
  - Create menu sections

### 2. Quick Actions

- **Action Shortcuts**
  - Assign keyboard shortcuts to any action
  - Create custom actions
  - Action groups
  - Action presets

### 3. Preferences

- **Settings Panel**
  - Agent settings (timeout, reconnection)
  - UI settings (theme, font)
  - Keyboard shortcuts
  - Notification preferences
  - Project settings

- **Import/Export Settings**
  - Export settings to file
  - Import settings from file
  - Sync settings across devices
  - Settings versioning

---

## 📊 Analytics and Insights

### 1. Usage Analytics

- **Command Usage**
  - Track most-used commands
  - Track command frequency
  - Track command patterns
  - Suggest shortcuts based on usage

### 2. Project Analytics

- **Project Activity**
  - Track time spent per project
  - Track sessions per project
  - Track commits per project
  - Track commands per project

### 3. Performance Metrics

- **Agent Performance**
  - Track agent response time
  - Track command execution time
  - Track connection quality
  - Alert on performance degradation

---

## 🎯 Priority Recommendations

### High Priority (Immediate Impact)

1. ✅ Menu bar status indicators (connection, session)
2. ✅ System-wide keyboard shortcuts (Cmd+Shift+T, etc.)
3. ✅ Quick git actions from menu bar
4. ✅ Project context awareness (detect from CWD)
5. ✅ Auto-reconnection on network changes

### Medium Priority (Nice to Have)

1. ✅ Notification Center integration
2. ✅ Spotlight/Alfred integration
3. ✅ Terminal command line tool (`termag open`, etc.)
4. ✅ Session templates
5. ✅ Resource usage monitoring

### Low Priority (Future Enhancements)

1. ✅ Touch Bar support
2. ✅ Control Center widget
3. ✅ Quick Look integration
4. ✅ Finder context menu
5. ✅ Usage analytics

---

## 🚀 Implementation Ideas

### Quick Wins (1-2 days)

1. Add menu bar status indicator
2. Add keyboard shortcuts for common actions
3. Add quick git actions menu
4. Add project detection from CWD
5. Add basic notifications

### Medium Effort (3-5 days)

1. Build Spotlight/Alfred plugin
2. Build CLI tool for terminal integration
3. Implement session templates
4. Add notification Center integration
5. Add resource monitoring

### Larger Effort (1-2 weeks)

1. Touch Bar support
2. Control Center widget
3. iTerm2 deep integration
4. Advanced session management
5. Usage analytics dashboard

---

## 📝 Notes

- All improvements should be optional (opt-in)
- Respect macOS HIG (Human Interface Guidelines)
- Maintain backward compatibility
- Keep performance overhead minimal
- Ensure accessibility (VoiceOver, keyboard navigation)
- Document all new features
