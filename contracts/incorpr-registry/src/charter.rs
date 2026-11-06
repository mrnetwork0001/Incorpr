//! On-chain charter rendered into NEP-177 `media`.
//!
//! Layout is a 600x360 monospace card. Values start at x=200 and the frame ends at x=588, so about
//! 49 columns fit at 13px. Long values are shortened before escaping: account ids keep their first
//! 20 and last 8 characters, the service wraps onto at most two lines of 46 columns, and a long
//! name drops to a smaller size, then ends in an ellipsis. East Asian wide glyphs count as two
//! columns. A clip path on the frame catches whatever a font still draws wider.

use near_sdk::base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use near_sdk::json_types::U128;
use near_sdk::{env, AccountId};

use crate::{Company, Encumbrance};

const TEXT: &str = "#ECE9E2";
const MUTED: &str = "#ADADAD";
const AMBER: &str = "#F0A24C";

const LINE_COLS: usize = 46;
const NAME_LARGE_COLS: usize = 28;
const NAME_SMALL_COLS: usize = 43;
const ID_HEAD: usize = 20;
const ID_TAIL: usize = 8;

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Not XML 1.0 characters, so not even escapable; valid_text lets them through.
            '\u{FFFE}' | '\u{FFFF}' => out.push('\u{FFFD}'),
            _ => out.push(c),
        }
    }
    out
}

/// Monospace columns a character takes: 2 for East Asian wide ranges and emoji, else 1.
fn cols(c: char) -> usize {
    match c as u32 {
        0x1100..=0x115F
        | 0x2E80..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

fn width(text: &str) -> usize {
    text.chars().map(cols).sum()
}

/// The longest prefix of `chars` that fits in `max` columns, as a char count.
fn fit(chars: &[char], max: usize) -> usize {
    let mut used = 0;
    chars.iter().take_while(|c| {
        used += cols(**c);
        used <= max
    }).count()
}

/// At most `max` columns, ending in an ellipsis when shortened.
fn clip_end(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out: String = chars[..fit(&chars, max - 1)].iter().collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// An account id shortened in the middle: first 20, an ellipsis, last 8.
fn short_id(id: &str) -> String {
    let n = id.chars().count();
    if n <= ID_HEAD + 1 + ID_TAIL {
        return id.to_string();
    }
    let head: String = id.chars().take(ID_HEAD).collect();
    let tail: String = id.chars().skip(n - ID_TAIL).collect();
    format!("{head}…{tail}")
}

/// Up to two lines of at most `LINE_COLS`, broken at the last space that fits, else mid-word.
/// The second line ends in an ellipsis when text is left over.
fn wrap_two(text: &str) -> (String, Option<String>) {
    let text = text.trim();
    if width(text) <= LINE_COLS {
        return (text.to_string(), None);
    }
    let chars: Vec<char> = text.chars().collect();
    let hard = fit(&chars, LINE_COLS);
    // A space right after the last character that fits is a clean break too.
    let cut = chars[..=hard].iter().rposition(|c| *c == ' ').filter(|i| *i > 0).unwrap_or(hard);
    let first: String = chars[..cut].iter().collect();
    let rest: String = chars[cut..].iter().collect();
    (first.trim_end().to_string(), Some(clip_end(rest.trim(), LINE_COLS)))
}

/// Micro-USDC as a decimal: at least two places, at most six, trailing zeros dropped.
fn usdc(micro: u128) -> String {
    let frac = format!("{:06}", micro % 1_000_000);
    let frac = frac.trim_end_matches('0');
    format!("{}.{:0<2}", micro / 1_000_000, frac)
}

fn pct(bps: u16) -> String {
    if bps.is_multiple_of(100) {
        format!("{}%", bps / 100)
    } else {
        format!("{}.{:02}%", bps / 100, bps % 100)
    }
}

const REVENUE_WINDOW_MS: u64 = 30 * 86_400_000;

/// The snapshot, or zero once every day it covered is more than 30 days old. Between reports it
/// can still overstate, so the charter prints its date.
pub fn current_revenue_30d(company: &Company) -> U128 {
    if env::block_timestamp_ms().saturating_sub(company.metrics_ms) >= REVENUE_WINDOW_MS {
        U128(0)
    } else {
        company.revenue_30d
    }
}

/// `YYYY-MM-DD` for a unix millisecond timestamp (Hinnant's civil-from-days).
fn date(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// State pill: label, colour, marker, and where the label starts. Marker and label are centred
/// together in the pill (x 472 to 568), as in the app: FREE circle, LISTED diamond, PLEDGED square.
fn pill(state: &Encumbrance) -> (&'static str, &'static str, &'static str, u16) {
    match state {
        Encumbrance::Free => ("FREE", "#79D4C0", "<circle cx=\"500\" cy=\"48\" r=\"3\"/>", 510),
        Encumbrance::Listed { .. } => {
            ("LISTED", AMBER, "<rect x=\"489.5\" y=\"45.5\" width=\"5\" height=\"5\" transform=\"rotate(45 492 48)\"/>", 502)
        }
        Encumbrance::Pledged { .. } => ("PLEDGED", "#C9B3FF", "<rect x=\"485\" y=\"45\" width=\"6\" height=\"6\" rx=\"1\"/>", 498),
    }
}

pub fn charter_svg(token_id: &str, company: &Company, owner: &AccountId) -> String {
    let (state, color, marker, label_x) = pill(&company.encumbrance);
    let [btc, sol, usdc_bps] = company.target_bps;
    // The smaller name sits lower so both sizes centre on the pill.
    let (name_size, name_y, name) = if width(&company.name) <= NAME_LARGE_COLS {
        (24, 58, company.name.clone())
    } else {
        (16, 54, clip_end(&company.name, NAME_SMALL_COLS))
    };
    let (service_1, service_2) = wrap_two(&company.service_template);
    let service_2 = service_2.map_or(String::new(), |line| format!("<tspan x=\"200\" dy=\"17\">{}</tspan>", xml_escape(&line)));
    let as_of = if company.metrics_ms == 0 { "incorporation".to_string() } else { date(company.metrics_ms) };
    format!(
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 360\" font-family=\"monospace\">",
            "<defs><clipPath id=\"f\"><rect x=\"12\" y=\"12\" width=\"576\" height=\"336\" rx=\"10\"/></clipPath></defs>",
            "<rect width=\"600\" height=\"360\" fill=\"#0D0D0D\"/>",
            "<rect x=\"12.5\" y=\"12.5\" width=\"575\" height=\"335\" rx=\"10\" fill=\"#141210\" stroke=\"{amber}\" stroke-opacity=\".35\"/>",
            "<g clip-path=\"url(#f)\">",
            "<text x=\"32\" y=\"{name_y}\" fill=\"{text}\" font-size=\"{name_size}\">{name}</text>",
            "<text x=\"32\" y=\"84\" fill=\"{muted}\" font-size=\"13\">Charter #{id} · {vault}</text>",
            "<g fill=\"{color}\"><rect x=\"472\" y=\"34\" width=\"96\" height=\"28\" rx=\"14\" fill-opacity=\".09\" stroke=\"{color}\" stroke-opacity=\".38\"/>",
            "{marker}<text x=\"{label_x}\" y=\"52\" font-size=\"12\" letter-spacing=\"1.2\">{state}</text></g>",
            "<path d=\"M32 106H568M32 312H568\" stroke=\"{amber}\" stroke-opacity=\".25\"/>",
            "<g font-size=\"13\" fill=\"{muted}\">",
            "<text x=\"32\" y=\"136\">Service</text>",
            "<text x=\"32\" y=\"182\">Price per call</text>",
            "<text x=\"32\" y=\"210\">Target allocation</text>",
            "<text x=\"32\" y=\"238\">30d revenue</text>",
            "<text x=\"32\" y=\"266\">Calls served</text>",
            "<text x=\"32\" y=\"294\">Owner</text>",
            "</g><g font-size=\"13\" fill=\"{text}\">",
            "<text x=\"200\" y=\"136\">{service_1}{service_2}</text>",
            "<text x=\"200\" y=\"182\">{price} USDC</text>",
            "<text x=\"200\" y=\"210\">{btc} BTC / {sol} SOL / {usdc} USDC</text>",
            "<text x=\"200\" y=\"238\">{revenue} USDC as of {as_of}</text>",
            "<text x=\"200\" y=\"266\">{calls}</text>",
            "<text x=\"200\" y=\"294\">{owner}</text>",
            "</g>",
            "<text x=\"32\" y=\"334\" fill=\"{amber}\" font-size=\"11\" letter-spacing=\"2\">INCORPR</text>",
            "<text x=\"568\" y=\"334\" fill=\"{muted}\" font-size=\"11\" text-anchor=\"end\">NEP-171 company charter</text>",
            "</g></svg>"
        ),
        text = TEXT,
        muted = MUTED,
        amber = AMBER,
        name_size = name_size,
        name_y = name_y,
        name = xml_escape(&name),
        id = xml_escape(&short_id(token_id)),
        vault = xml_escape(&short_id(company.vault.as_str())),
        color = color,
        marker = marker,
        label_x = label_x,
        state = state,
        service_1 = xml_escape(&service_1),
        service_2 = service_2,
        price = usdc(company.price_micro_usdc.0),
        btc = pct(btc),
        sol = pct(sol),
        usdc = pct(usdc_bps),
        revenue = usdc(current_revenue_30d(company).0),
        as_of = as_of,
        calls = company.calls,
        owner = xml_escape(&short_id(owner.as_str())),
    )
}

pub fn charter_data_uri(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", BASE64.encode(svg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const LONG_OWNER: &str = "717260aea2e5c0d732a164cbbd16ec066112be7a6fa79f91c6f5164ee9b765b9";
    const LONG_SERVICE: &str = "Audit this smart contract & list each bug, its severity <1-5>, a fix.";

    fn company(name: &str, service: &str, encumbrance: Encumbrance) -> Company {
        testing_env!(VMContextBuilder::new().block_timestamp(1_793_407_936_746 * 1_000_000).build());
        Company {
            name: name.to_string(),
            service_template: service.to_string(),
            price_micro_usdc: U128(50_000),
            target_bps: [4_000, 3_000, 3_000],
            founder: "founder.near".parse().unwrap(),
            founder_royalty_bps: 0,
            compute_reserve_bps: 100,
            vault: "c-1.incorpr.near".parse().unwrap(),
            created_ms: 1,
            gross: U128(50_000),
            retained: U128(42_500),
            revenue_30d: U128(1_250_000),
            calls: 7,
            metrics_ms: 1_793_407_936_746,
            encumbrance,
            settling: false,
            needs_resync: false,
            sync_nonce: 0,
        }
    }

    fn states() -> [Encumbrance; 3] {
        [
            Encumbrance::Free,
            Encumbrance::Listed { ask: U128(1_000_000) },
            Encumbrance::Pledged { lender: "lender.near".parse().unwrap(), debt: U128(1), due_ms: 1 },
        ]
    }

    /// The text content of every `<text>`/`<tspan>` run, entities left as written.
    fn runs(svg: &str) -> Vec<String> {
        svg.split('>')
            .filter_map(|part| part.split('<').next())
            .filter(|run| !run.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn unescaped_width(run: &str) -> usize {
        width(&run.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'"))
    }

    #[test]
    fn date_known_instants() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400_000), "2000-02-29");
        assert_eq!(date(1_793_407_936_746), "2026-10-31");
    }

    #[test]
    fn amounts_have_no_dollar_sign_and_keep_small_prices() {
        assert_eq!(usdc(50_000), "0.05");
        assert_eq!(usdc(0), "0.00");
        assert_eq!(usdc(1_000_000), "1.00");
        assert_eq!(usdc(5_000), "0.005");
        assert_eq!(usdc(1_234_567), "1.234567");
        let svg = charter_svg("1", &company("Ledgerline Audit", "s", Encumbrance::Free), &"a.near".parse().unwrap());
        assert!(!svg.contains('$'), "{svg}");
        assert!(svg.contains(">0.05 USDC<") && svg.contains(">1.25 USDC as of 2026-10-31<"), "{svg}");
    }

    #[test]
    fn long_account_ids_are_shortened_in_the_middle() {
        assert_eq!(short_id(LONG_OWNER), "717260aea2e5c0d732a1…e9b765b9");
        assert_eq!(short_id("demo-buyer.incorpr.near"), "demo-buyer.incorpr.near");
        let exactly = "a".repeat(29);
        assert_eq!(short_id(&exactly), exactly);
        let svg = charter_svg("1", &company("n", "s", Encumbrance::Free), &LONG_OWNER.parse().unwrap());
        assert!(svg.contains(">717260aea2e5c0d732a1…e9b765b9<"), "{svg}");
        assert!(!svg.contains(LONG_OWNER));
    }

    #[test]
    fn long_service_wraps_onto_two_lines_with_an_ellipsis() {
        let (first, second) = wrap_two(LONG_SERVICE);
        let second = second.unwrap();
        assert!(width(&first) <= LINE_COLS && width(&second) <= LINE_COLS);
        assert_eq!(first, "Audit this smart contract & list each bug, its");
        assert_eq!(second, "severity <1-5>, a fix.");

        let overflow = "word ".repeat(30);
        let (first, second) = wrap_two(&overflow);
        let second = second.unwrap();
        assert!(width(&first) <= LINE_COLS && width(&second) <= LINE_COLS);
        assert!(second.ends_with('…'));

        let unbroken = "x".repeat(64);
        let (first, second) = wrap_two(&unbroken);
        assert_eq!(first.chars().count(), LINE_COLS);
        assert_eq!(second.unwrap(), "x".repeat(18));

        // Wide glyphs take two columns: 23 per line.
        let (first, second) = wrap_two(&"公".repeat(30));
        assert_eq!((first.chars().count(), second.unwrap().chars().count()), (23, 7));

        let svg = charter_svg("1", &company("n", LONG_SERVICE, Encumbrance::Free), &"a.near".parse().unwrap());
        assert!(svg.contains("<tspan x=\"200\" dy=\"17\">severity &lt;1-5&gt;, a fix.</tspan>"), "{svg}");
        assert!(svg.contains("contract &amp; list"));
    }

    #[test]
    fn every_value_fits_the_frame_in_every_state() {
        // 64 bytes each, the most incorporate_company accepts: ASCII, and 21 wide glyphs.
        let wide = "公司".repeat(11)[..63].to_string();
        let cases = [("N".repeat(64), "word ".repeat(13)), (wide.clone(), wide)];
        for state in states() {
            for (name, service) in &cases {
                let svg = charter_svg("1", &company(name, service, state.clone()), &LONG_OWNER.parse().unwrap());
                assert!(svg.contains("clip-path=\"url(#f)\""));
                for run in runs(&svg) {
                    // Name at 16px: 43 columns; every 13px run: 49 from x=200, more from x=32.
                    assert!(unescaped_width(&run) <= 49, "run too long: {run}");
                }
            }
        }
    }

    #[test]
    fn pill_colour_and_label_follow_the_encumbrance() {
        let owner: AccountId = "a.near".parse().unwrap();
        let expected = [("FREE", "#79D4C0"), ("LISTED", "#F0A24C"), ("PLEDGED", "#C9B3FF")];
        for (state, (label, color)) in states().into_iter().zip(expected) {
            let svg = charter_svg("1", &company("n", "s", state), &owner);
            assert!(svg.contains(&format!("<g fill=\"{color}\">")), "{svg}");
            assert!(svg.contains(&format!(">{label}</text>")), "{svg}");
        }
    }

    #[test]
    fn rendering_is_deterministic_and_escaped() {
        let c = company("Acme <Translate> & \"Co\"", "it's <b>", Encumbrance::Free);
        let owner: AccountId = "a.near".parse().unwrap();
        let svg = charter_svg("1", &c, &owner);
        assert_eq!(svg, charter_svg("1", &c, &owner));
        assert!(svg.contains("Acme &lt;Translate&gt; &amp; &quot;Co&quot;"));
        assert!(svg.contains("it&apos;s &lt;b&gt;"));
        assert_eq!(svg.matches("<text").count(), svg.matches("</text>").count());
    }

    #[test]
    fn non_xml_characters_become_the_replacement_character() {
        let c = company("Bad\u{FFFE}Name", "x\u{FFFF}y", Encumbrance::Free);
        let svg = charter_svg("1", &c, &"a.near".parse().unwrap());
        assert!(!svg.contains('\u{FFFE}') && !svg.contains('\u{FFFF}'), "{svg}");
        assert!(svg.contains("Bad\u{FFFD}Name") && svg.contains("x\u{FFFD}y"), "{svg}");
    }

    /// Writes sample charters for a visual check: CHARTER_SAMPLES_DIR=/some/dir cargo test -- --ignored
    #[test]
    #[ignore = "writes files; set CHARTER_SAMPLES_DIR"]
    fn write_samples() {
        let dir = std::env::var("CHARTER_SAMPLES_DIR").expect("CHARTER_SAMPLES_DIR");
        let owner: AccountId = LONG_OWNER.parse().unwrap();
        for (state, label) in states().into_iter().zip(["free", "listed", "pledged"]) {
            let c = company("Ledgerline Audit", LONG_SERVICE, state.clone());
            std::fs::write(format!("{dir}/{label}.svg"), charter_svg("1", &c, &owner)).unwrap();
            let c = company(&"Northwind Translation Bureau Intl".repeat(2)[..64], &"word ".repeat(13), state.clone());
            std::fs::write(format!("{dir}/{label}-long-name.svg"), charter_svg("12345", &c, &owner)).unwrap();
            let c = company(&"公司".repeat(11)[..63], &"审计".repeat(11)[..63], state);
            std::fs::write(format!("{dir}/{label}-wide.svg"), charter_svg("1", &c, &owner)).unwrap();
        }
    }
}
