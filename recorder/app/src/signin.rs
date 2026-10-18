//! Signing in inside the aim4 window.
//!
//! The window sends every address that is not the site to the user's browser.
//! A sign-in cannot go that way: Google, X, Discord and Steam end by handing a
//! session to the page that started the sign-in, and if that page is the
//! browser's, the window never gets it. So the sign-in pages stay in the window.
//!
//! A local host has a second problem. aim4's Supabase project only returns to
//! the addresses on its redirect list (aim4.io and www.aim4.io), so a sign-in
//! started on http://localhost:3784 comes back to https://aim4.io carrying the
//! session. When the window is on a local host, that landing is loaded on the
//! local host instead (same path, query and fragment), where the page signs in
//! with it. Nothing else on aim4.io is touched.

/// The hosted site, where Supabase sends a sign-in it would not return to localhost.
const HOSTED: [&str; 2] = ["aim4.io", "www.aim4.io"];

/// What marks a URL as the end of a sign-in: implicit tokens, a PKCE code, or a provider error.
const LANDING_MARKS: [&str; 3] = ["access_token=", "code=", "error_description="];

/// The host of an http(s) URL, lower-cased, without port or user info.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Everything after the host: path, query and fragment, always starting with "/".
fn after_host(url: &str) -> String {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url);
    let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let tail = &rest[cut..];
    if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    }
}

/// A page of a sign-in flow, which has to run in the window rather than the browser.
pub fn is_sign_in_page(url: &str) -> bool {
    let Some(host) = host_of(url) else { return false };
    host.ends_with(".supabase.co")
        // Google signs in on accounts.google.com and sets its cookies on the
        // country domains (accounts.google.no, …) and on YouTube along the way.
        || host == "accounts.google.com"
        || host.starts_with("accounts.google.")
        || host == "accounts.youtube.com"
        || matches!(host.as_str(), "x.com" | "twitter.com" | "api.x.com" | "api.twitter.com")
        || matches!(host.as_str(), "discord.com" | "www.discord.com")
        || (host == "steamcommunity.com" && after_host(url).starts_with("/openid"))
}

/// Where a sign-in that landed on aim4.io should be finished, when the window is on a local host.
pub fn local_landing(url: &str, base: &str) -> Option<String> {
    let base_host = host_of(base)?;
    if HOSTED.contains(&base_host.as_str()) {
        return None;
    }
    let host = host_of(url)?;
    if !HOSTED.contains(&host.as_str()) || !LANDING_MARKS.iter().any(|m| url.contains(m)) {
        return None;
    }
    Some(format!("{}{}", base.trim_end_matches('/'), after_host(url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "http://localhost:3784";

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://accounts.google.com/o/oauth2/v2/auth?x=1").as_deref(), Some("accounts.google.com"));
        assert_eq!(host_of("http://localhost:3784/#a=b").as_deref(), Some("localhost"));
        assert_eq!(host_of("https://user@AIM4.io:443?x").as_deref(), Some("aim4.io"));
        assert_eq!(host_of("about:blank"), None);
    }

    #[test]
    fn sign_in_pages_stay_in_the_window() {
        for url in [
            "https://srzzubymegwzmmqzdgpv.supabase.co/auth/v1/authorize?provider=google",
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=1",
            "https://accounts.google.no/accounts/SetSID",
            "https://accounts.youtube.com/accounts/SetSID",
            "https://x.com/i/oauth2/authorize",
            "https://discord.com/oauth2/authorize?x",
            "https://steamcommunity.com/openid/login?openid.mode=checkid_setup",
        ] {
            assert!(is_sign_in_page(url), "{url}");
        }
        for url in [
            "https://www.google.com/search?q=aim4",
            "https://steamcommunity.com/id/someone",
            "https://hltv.org/matches",
            "https://notsupabase.co/x",
            "https://evil.com/?next=accounts.google.com",
        ] {
            assert!(!is_sign_in_page(url), "{url}");
        }
    }

    #[test]
    fn a_sign_in_that_lands_on_aim4_io_finishes_locally() {
        assert_eq!(
            local_landing("https://aim4.io/#access_token=a&refresh_token=b&type=bearer", LOCAL).as_deref(),
            Some("http://localhost:3784/#access_token=a&refresh_token=b&type=bearer")
        );
        assert_eq!(
            local_landing("https://www.aim4.io/account?code=abc123", LOCAL).as_deref(),
            Some("http://localhost:3784/account?code=abc123")
        );
        assert_eq!(
            local_landing("https://aim4.io?error=access_denied&error_description=nope", LOCAL).as_deref(),
            Some("http://localhost:3784/?error=access_denied&error_description=nope")
        );
    }

    #[test]
    fn everything_else_on_aim4_io_is_left_alone() {
        assert_eq!(local_landing("https://aim4.io/pricing", LOCAL), None, "an ordinary link");
        assert_eq!(local_landing("https://aim4.io/#access_token=a", "https://aim4.io"), None, "the hosted window signs in normally");
        assert_eq!(local_landing("https://example.com/#access_token=a", LOCAL), None, "not aim4.io");
    }
}
