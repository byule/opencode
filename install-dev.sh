#!/usr/bin/env bash
set -euo pipefail

APP=opencode
REPO="https://github.com/byule/opencode.git"
BRANCH="dev"
INSTALL_DIR="$HOME/.opencode-dev"

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

# Set up shell alias
print_message info "\n${MUTED}Configuring shell alias...${NC}"

ALIAS_CMD="alias opencode='bun run --cwd $INSTALL_DIR/packages/opencode dev --'"

current_shell=$(basename "$SHELL")
case $current_shell in
    zsh)
        config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv"
        ;;
    bash)
        config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile"
        ;;
    fish)
        config_files="$HOME/.config/fish/config.fish"
        ALIAS_CMD="alias opencode 'bun run --cwd $INSTALL_DIR/packages/opencode dev --'"
        ;;
    *)
        config_files="$HOME/.bashrc $HOME/.profile"
        ;;
esac

config_file=""
for file in $config_files; do
    if [ -f "$file" ]; then
        config_file=$file
        break
    fi
done

if [ -z "$config_file" ]; then
    config_file="$HOME/.zshrc"
    [ "$current_shell" = "bash" ] && config_file="$HOME/.bashrc"
fi

add_alias() {
    local file=$1
    local cmd=$2

    if grep -Fq "$INSTALL_DIR/packages/opencode" "$file" 2>/dev/null; then
        print_message warning "  opencode alias already exists in $(basename "$file"), skipping."
    else
        echo "" >> "$file"
        echo "# opencode dev branch (byule fork)" >> "$file"
        echo "$cmd" >> "$file"
        print_message success "  Added alias to $(basename "$file")"
    fi
}

add_alias "$config_file" "$ALIAS_CMD"

# Also add a convenience wrapper for CF Access
cat > "$INSTALL_DIR/attach-cf" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
    echo "Usage: attach-cf <url>"
    echo "Example: attach-cf https://4096-sb-867770819f83-j6kaxtmu0u7opzod.superseal.cloudflare.dev/"
    exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared is required. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
fi

TOKEN=$(cloudflared access token --app="$URL")
exec opencode attach "$URL" -H "cf-access-token: $TOKEN"
WRAPPER
chmod +x "$INSTALL_DIR/attach-cf"

# Summary
echo ""
echo -e "${MUTED}                    ${NC}             ▄     "
echo -e "${MUTED}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ ${NC}█▀▀▀ █▀▀█ █▀▀█ █▀▀█"
echo -e "${MUTED}█░░█ █░░█ █▀▀▀ █░░█ ${NC}█░░░ █░░█ █░░█ █▀▀▀"
echo -e "${MUTED}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ${NC}▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"
echo -e ""
print_message success "OpenCode (dev branch) installed successfully!"
echo ""
echo -e "${MUTED}To use it now, run:${NC}"
echo -e "  source $(basename "$config_file")"
echo ""
echo -e "${MUTED}Then you can run:${NC}"
echo -e "  opencode --version              ${MUTED}# Should print 'local'${NC}"
echo -e "  opencode attach <url> -H \"cf-access-token: <token>\""
echo ""
echo -e "${MUTED}For CF Access-protected servers:${NC}"
echo -e "  $INSTALL_DIR/attach-cf <url>    ${MUTED}# Auto-fetches token via cloudflared${NC}"
echo ""
echo -e "${MUTED}Example:${NC}"
echo -e "  attach-cf https://4096-sb-867770819f83-j6kaxtmu0u7opzod.superseal.cloudflare.dev/"
echo ""
