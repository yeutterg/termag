class Terminalz < Formula
  desc "Lightweight agent and CLI for multi-machine terminal streaming"
  homepage "https://github.com/yeutterg/terminalz"
  head "https://github.com/yeutterg/terminalz.git"
  license "MIT"

  depends_on "rust" => :build

  def install
    system "cargo", "install", "--locked", "--root", prefix, "--path", "apps/agent-rs"
  end

  service do
    run [opt_bin/"terminalz"]
    keep_alive crashed: true
    process_type :background
    log_path var/"log/terminalz.log"
    error_log_path var/"log/terminalz.log"
  end

  test do
    assert_match "terminalz", shell_output("#{bin}/terminalz --version")
  end
end
