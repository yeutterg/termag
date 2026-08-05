class TermagAgent < Formula
  desc "Low-footprint Termag agent for mirrored HerdR and tmux sessions"
  homepage "https://github.com/yeutterg/termag-next"
  head "https://github.com/yeutterg/termag-next.git", branch: "master"
  license "MIT"

  depends_on "rust" => :build

  def install
    system "cargo", "install", "--locked", "--root", prefix, "--path", "apps/agent-rs"
    bin.install_symlink "termag-agent" => "termag"
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
    assert_match "termag-agent", shell_output("#{bin}/termag --version")
  end
end
