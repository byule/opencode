#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/byule/opencode.git"
BRANCH="dev"
INSTALL_DIR="$HOME/.cfcode"
BIN_DIR="$INSTALL_DIR/bin"

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
GREEN='\033[0;32m'
NC='\033[0m'

print_message() {
    local level=$1
    local message=$2
    local color=""
    case $level in
        info) color="${NC}" ;;
        success) color="${GREEN}" ;;
        warning) color="${ORANGE}" ;;
        error) color="${RED}" ;;
    esac
    echo -e "${color}${message}${NC}"
}

# Check prerequisites
print_message info "Checking prerequisites..."

if ! command -v git >/dev/null 2>&1; then
    print_message error "git is required but not installed. Install it first:"
    echo "  macOS: brew install git"
    echo "  Ubuntu/Debian: sudo apt-get install git"
    exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
    print_message error "bun is required but not installed. Install it first:"
    echo "  curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

print_message success "  git: $(git --version | awk '{print $3}')"
print_message success "  bun: $(bun --version)"

# Clone or update the repository
if [ -d "$INSTALL_DIR/.git" ]; then
    print_message info "\n${MUTED}Updating existing repo at ${NC}$INSTALL_DIR"
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
else
    print_message info "\n${MUTED}Cloning ${NC}byule/opencode${MUTED} (${BRANCH} branch) into ${NC}$INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
    git clone --branch "$BRANCH" --single-branch "$REPO" "$INSTALL_DIR"
fi

# Install dependencies
print_message info "\n${MUTED}Installing dependencies...${NC}"
cd "$INSTALL_DIR"
bun install

# Create wrapper scripts
print_message info "\n${MUTED}Creating wrapper scripts in ${NC}$BIN_DIR"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/cfcode" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.cfcode"

# If first argument looks like a URL, treat it as 'attach <url>'
if [ $# -gt 0 ] && [[ "${1:-}" =~ ^https?:// ]]; then
    URL="$1"
    shift

    # cloudflared is required for URL shorthand
    if ! command -v cloudflared >/dev/null 2>&1; then
        echo "Error: cloudflared is required to connect to remote URLs." >&2
        echo "Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
        exit 1
    fi

    # Fetch CF Access token (shows browser login link if needed)
    TOKEN=$(cloudflared access token --app="$URL")

    exec bun run --cwd "$INSTALL_DIR/packages/opencode" dev -- attach "$URL" -H "cf-access-token: $TOKEN" "$@"
fi

# Otherwise pass through to opencode normally
exec bun run --cwd "$INSTALL_DIR/packages/opencode" dev -- "$@"
WRAPPER
chmod +x "$BIN_DIR/cfcode"

# Determine shell config file
current_shell=$(basename "$SHELL")
case $current_shell in
    zsh)
        config_file="${ZDOTDIR:-$HOME}/.zshrc"
        ;;
    bash)
        config_file="$HOME/.bashrc"
        ;;
    fish)
        config_file="$HOME/.config/fish/config.fish"
        ;;
    *)
        config_file="$HOME/.profile"
        ;;
esac

# Add to PATH if not already there
print_message info "\n${MUTED}Configuring PATH...${NC}"

if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
    print_message success "  $BIN_DIR is already in your PATH"
else
    if [ -f "$config_file" ]; then
        if grep -Fq "$BIN_DIR" "$config_file" 2>/dev/null; then
            print_message warning "  PATH entry already exists in $(basename "$config_file"), skipping."
        else
            echo "" >> "$config_file"
            echo "# cfcode (byule's opencode fork)" >> "$config_file"
            echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$config_file"
            print_message success "  Added $BIN_DIR to PATH in $(basename "$config_file")"
        fi
    else
        print_message warning "  Could not find shell config. Add this manually:"
        echo "    export PATH=\"$BIN_DIR:\$PATH\""
    fi
fi

# Summary
echo ""
echo -e "${MUTED}                    ${NC}             ▄     "
echo -e "${MUTED}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ ${NC}█▀▀▀ █▀▀█ █▀▀█ █▀▀█"
echo -e "${MUTED}█░░█ █░░█ █▀▀▀ █░░█ ${NC}█░░░ █░░█ █░░█ █▀▀▀"
echo -e "${MUTED}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ${NC}▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"
echo -e ""
print_message success "cfcode installed successfully!"
echo ""
echo -e "${MUTED}To use it now, run:${NC}"
echo -e "  source $(basename "$config_file" 2>/dev/null || echo 'your shell config')"
echo ""
echo -e "${MUTED}Then verify:${NC}"
echo -e "  cfcode --version                ${MUTED}# Should print 'local'${NC}"
echo -e "  cfcode attach <url> -H \"cf-access-token: <token>\""
echo ""
echo -e "${MUTED}Quick connect to a remote URL (requires cloudflared):${NC}"
echo -e "  cfcode <url>                    ${MUTED}# Auto-fetches CF Access token and attaches${NC}"
echo ""
echo -e "${MUTED}Example:${NC}"
echo -e "  cfcode https://4096-sb-867770819f83-j6kaxtmu0u7opzod.superseal.cloudflare.dev/"
echo ""
