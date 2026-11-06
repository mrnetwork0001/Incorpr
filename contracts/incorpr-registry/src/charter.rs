//! On-chain charter rendered into NEP-177 `media`.

use near_sdk::base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use near_sdk::json_types::U128;
use near_sdk::{env, AccountId};

use crate::{Company, Encumbrance};

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn usd(micro: u128) -> String {
    format!("${}.{:02}", micro / 1_000_000, (micro % 1_000_000) / 10_000)
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

pub fn charter_svg(token_id: &str, company: &Company, owner: &AccountId) -> String {
    let (pill, color) = match company.encumbrance {
        Encumbrance::Free => ("FREE", "#16a34a"),
        Encumbrance::Listed { .. } => ("LISTED", "#d97706"),
        Encumbrance::Pledged { .. } => ("PLEDGED", "#7c3aed"),
    };
    let [btc, sol, usdc] = company.target_bps;
    format!(
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 360\" font-family=\"monospace\">",
            "<rect width=\"600\" height=\"360\" fill=\"#0b0f14\"/>",
            "<rect x=\"12\" y=\"12\" width=\"576\" height=\"336\" fill=\"none\" stroke=\"#334155\"/>",
            "<text x=\"32\" y=\"56\" fill=\"#f8fafc\" font-size=\"24\">{name}</text>",
            "<text x=\"32\" y=\"82\" fill=\"#94a3b8\" font-size=\"13\">Charter #{id} / {vault}</text>",
            "<rect x=\"468\" y=\"32\" width=\"100\" height=\"28\" rx=\"4\" fill=\"{color}\"/>",
            "<text x=\"518\" y=\"51\" fill=\"#ffffff\" font-size=\"13\" text-anchor=\"middle\">{pill}</text>",
            "<text x=\"32\" y=\"130\" fill=\"#94a3b8\" font-size=\"13\">Service</text>",
            "<text x=\"200\" y=\"130\" fill=\"#f8fafc\" font-size=\"13\">{service}</text>",
            "<text x=\"32\" y=\"158\" fill=\"#94a3b8\" font-size=\"13\">Price per call</text>",
            "<text x=\"200\" y=\"158\" fill=\"#f8fafc\" font-size=\"13\">{price} USDC</text>",
            "<text x=\"32\" y=\"186\" fill=\"#94a3b8\" font-size=\"13\">Target allocation</text>",
            "<text x=\"200\" y=\"186\" fill=\"#f8fafc\" font-size=\"13\">{btc} BTC / {sol} SOL / {usdc} USDC</text>",
            "<text x=\"32\" y=\"214\" fill=\"#94a3b8\" font-size=\"13\">30d revenue</text>",
            "<text x=\"200\" y=\"214\" fill=\"#f8fafc\" font-size=\"13\">{revenue} as of {as_of}</text>",
            "<text x=\"32\" y=\"242\" fill=\"#94a3b8\" font-size=\"13\">Calls served</text>",
            "<text x=\"200\" y=\"242\" fill=\"#f8fafc\" font-size=\"13\">{calls}</text>",
            "<text x=\"32\" y=\"270\" fill=\"#94a3b8\" font-size=\"13\">Owner</text>",
            "<text x=\"200\" y=\"270\" fill=\"#f8fafc\" font-size=\"13\">{owner}</text>",
            "</svg>"
        ),
        name = xml_escape(&company.name),
        id = xml_escape(token_id),
        vault = company.vault,
        color = color,
        pill = pill,
        service = xml_escape(&company.service_template),
        price = usd(company.price_micro_usdc.0),
        btc = pct(btc),
        sol = pct(sol),
        usdc = pct(usdc),
        revenue = usd(current_revenue_30d(company).0),
        as_of = if company.metrics_ms == 0 { "incorporation".to_string() } else { date(company.metrics_ms) },
        calls = company.calls,
        owner = owner,
    )
}

pub fn charter_data_uri(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", BASE64.encode(svg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_known_instants() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400_000), "2000-02-29");
        assert_eq!(date(1_793_407_936_746), "2026-10-31");
    }
}
