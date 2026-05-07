class TermagAgent < Formula
  desc "Outbound termag laptop agent for tmux-backed remote coding sessions"
  homepage "https://github.com/yeutterg/termag-next"
  # The release script (apps/agent/scripts/release.sh) prints the new url +
  # sha256 after each `npm publish`. Paste them here, commit, push your tap.
  url "https://registry.npmjs.org/@yeutterg/agent/-/agent-0.1.1.tgz"
  sha256 "06cc71e466e2563158e35b057df7eb9719f052cd68e40ee20279bd762576b7b3"
  license "MIT"

  depends_on "node"
  depends_on "tmux"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"termag-agent"]
    keep_alive true
    log_path var/"log/termag-agent.log"
    error_log_path var/"log/termag-agent.log"
    # Users override TERMAG_URL / TERMAG_AGENT_TOKEN / TERMAG_AGENT_ROOTS via
    # `brew services edit termag-agent` or by editing the launchd plist.
    environment_variables TERMAG_URL: "wss://CHANGE_ME/api/ws/agent"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/termag-agent --version")
  end
end
