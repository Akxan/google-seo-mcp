# Security policy

## Supported versions

Security fixes go into the latest release and `main`. Please upgrade to the newest version before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Report them privately through GitHub: open the [Security tab](https://github.com/Akxan/google-seo-mcp/security) of this repository and choose **Report a vulnerability**. Include:

- the affected tool, file or endpoint and the version or commit;
- steps to reproduce, and what an attacker could achieve;
- any suggested fix.

You will get an acknowledgement as soon as the report is read, and we will keep you informed while a fix is prepared. Please give us reasonable time to release the fix before disclosing it.

## Scope

Reports are especially welcome for:

- leaking credentials or tokens (Google service accounts, OAuth refresh tokens, GitHub tokens, the HTTP bearer token);
- server-side request forgery or unbounded downloads in the tools that fetch URLs;
- command injection in the WordPress tools (WP-CLI over SSH);
- bypassing read-only mode, toolset restrictions or authentication in the HTTP and hosted modes;
- prompt-injection paths where fetched page content can trigger write tools without the user's intent.

Out of scope: findings that require an already compromised host or stolen credentials, and missing hardening headers on third-party sites the tools audit.

> 中文：发现安全问题请不要公开提 Issue，请在本仓库的 Security 页面点「Report a vulnerability」私下报告。
