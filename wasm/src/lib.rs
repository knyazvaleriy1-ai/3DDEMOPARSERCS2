//! demoparser2's parser as a WebAssembly module for the in-browser version.
//!
//! The demo is copied into wasm memory once (`begin` + `push` in chunks, so a
//! 500 MB file never exists twice in JS), then parsed in several passes like
//! the Python package does: `header`, `events`, `ticks`, `grenades`, `voice`.
//!
//! Tick data comes back column-wise: numbers as `Float64Array`/`Float32Array`
//! (NaN = missing), booleans as `Uint8Array` (0, 1, 2 = missing) and strings
//! (steamids included) dictionary-encoded as `{dict: string[], idx: Uint32Array}`
//! (0xFFFFFFFF = missing). Row objects for ~1M rows would not fit a phone.

use std::cell::RefCell;
use std::collections::HashMap;

use ahash::AHashMap;
use js_sys::{Array, Float32Array, Float64Array, Object, Reflect, Uint32Array, Uint8Array};
use parser::first_pass::parser_settings::{rm_user_friendly_names, FirstPassParser, ParserInputs};
use parser::parse_demo::{DemoOutput, Parser, ParsingMode};
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::{PropColumn, VarVec, Variant};
use wasm_bindgen::prelude::*;

thread_local! {
    static DEMO: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static HUFFMAN: Vec<(u8, u8)> = create_huffman_lookup_table();
}

const MISSING: u32 = u32::MAX;

/// Start loading a demo of `len` bytes (drops the previous one).
#[wasm_bindgen]
pub fn begin(len: usize) {
    DEMO.with(|d| {
        let mut d = d.borrow_mut();
        *d = Vec::new();
        d.reserve_exact(len);
    });
}

/// Append the next chunk of the file.
#[wasm_bindgen]
pub fn push(chunk: &[u8]) {
    DEMO.with(|d| d.borrow_mut().extend_from_slice(chunk));
}

/// Free the demo bytes.
#[wasm_bindgen]
pub fn release() {
    DEMO.with(|d| *d.borrow_mut() = Vec::new());
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(obj, &JsValue::from_str(key), value);
}

fn real_names(props: &[String]) -> Result<(Vec<String>, AHashMap<String, String>), JsError> {
    let props = props.to_vec();
    let real = rm_user_friendly_names(&props).map_err(err)?;
    let mut map = AHashMap::default();
    for (r, og) in real.iter().zip(&props) {
        map.insert(r.clone(), og.clone());
    }
    Ok((real, map))
}

struct Pass {
    player_props: Vec<String>,
    other_props: Vec<String>,
    events: Vec<String>,
    ticks: Vec<i32>,
    projectiles: bool,
}

fn run(pass: Pass) -> Result<DemoOutput, JsError> {
    let (player_props, mut names) = real_names(&pass.player_props)?;
    let (other_props, other_names) = real_names(&pass.other_props)?;
    names.extend(other_names);
    HUFFMAN.with(|huf| {
        let settings = ParserInputs {
            real_name_to_og_name: names,
            wanted_players: vec![],
            wanted_player_props: player_props,
            wanted_other_props: other_props,
            wanted_prop_states: AHashMap::default(),
            wanted_ticks: pass.ticks,
            wanted_events: pass.events,
            parse_ents: true,
            parse_projectiles: pass.projectiles,
            parse_grenades: false,
            only_header: false,
            only_convars: false,
            huffman_lookup_table: huf,
            order_by_steamid: false,
            list_props: false,
            fallback_bytes: None,
        };
        DEMO.with(|d| {
            let bytes = d.borrow();
            if bytes.is_empty() {
                return Err(JsError::new("demo not loaded"));
            }
            // Normal = what the Python package uses: the demo is split at full
            // snapshots and each part parsed from a clean entity state (one
            // after another here: rayon runs on the current thread in wasm).
            // Single-threaded parsing keeps stale button masks across entity
            // re-creation, so its keys differ from the Python parser's.
            Parser::new(settings, ParsingMode::Normal).parse_demo(&bytes).map_err(err)
        })
    })
}

/// Demo header (map name, server, build …) as a plain object.
#[wasm_bindgen]
pub fn header() -> Result<JsValue, JsError> {
    HUFFMAN.with(|huf| {
        let settings = ParserInputs {
            real_name_to_og_name: AHashMap::default(),
            wanted_players: vec![],
            wanted_player_props: vec![],
            wanted_other_props: vec![],
            wanted_prop_states: AHashMap::default(),
            wanted_ticks: vec![],
            wanted_events: vec![],
            parse_ents: false,
            parse_projectiles: false,
            parse_grenades: false,
            only_header: true,
            only_convars: false,
            huffman_lookup_table: huf,
            order_by_steamid: false,
            list_props: false,
            fallback_bytes: None,
        };
        DEMO.with(|d| {
            let bytes = d.borrow();
            let mut first = FirstPassParser::new(&settings);
            let out = first.parse_header_only(&bytes).map_err(err)?;
            let obj = Object::new();
            let sorted: HashMap<_, _> = out.into_iter().collect();
            for (k, v) in sorted {
                set(&obj, &k, &JsValue::from_str(&v));
            }
            Ok(obj.into())
        })
    })
}

fn variant(v: &Variant) -> JsValue {
    match v {
        Variant::Bool(b) => JsValue::from_bool(*b),
        Variant::U32(x) => JsValue::from_f64(*x as f64),
        Variant::I32(x) => JsValue::from_f64(*x as f64),
        Variant::F32(x) => JsValue::from_f64(*x as f64),
        // steamids: keep all 64 bits
        Variant::U64(x) => JsValue::from_str(&x.to_string()),
        Variant::String(s) => JsValue::from_str(s),
        Variant::VecXY(a) => a.iter().map(|x| JsValue::from_f64(*x as f64)).collect::<Array>().into(),
        Variant::VecXYZ(a) => a.iter().map(|x| JsValue::from_f64(*x as f64)).collect::<Array>().into(),
        Variant::StringVec(v) => v.iter().map(|s| JsValue::from_str(s)).collect::<Array>().into(),
        Variant::U32Vec(v) => v.iter().map(|x| JsValue::from_f64(*x as f64)).collect::<Array>().into(),
        Variant::U64Vec(v) => v.iter().map(|x| JsValue::from_str(&x.to_string())).collect::<Array>().into(),
        _ => JsValue::NULL,
    }
}

/// Game events: `{event_name: [{tick, field: value, …}, …]}` sorted by tick.
#[wasm_bindgen]
pub fn events(names: Vec<String>, player_props: Vec<String>, other_props: Vec<String>) -> Result<JsValue, JsError> {
    let out = run(Pass { player_props, other_props, events: names, ticks: vec![], projectiles: false })?;
    let mut events = out.game_events;
    events.sort_by_key(|e| e.tick);
    let result = Object::new();
    let mut lists: AHashMap<String, Array> = AHashMap::default();
    for ev in &events {
        let row = Object::new();
        set(&row, "tick", &JsValue::from_f64(ev.tick as f64));
        for f in &ev.fields {
            let value = match &f.data {
                Some(v) => variant(v),
                None => JsValue::NULL,
            };
            set(&row, &f.name, &value);
        }
        lists.entry(ev.name.clone()).or_insert_with(Array::new).push(&row);
    }
    for (name, list) in lists {
        set(&result, &name, &list);
    }
    Ok(result.into())
}

fn dict_column<'a>(values: impl Iterator<Item = Option<String>>) -> JsValue {
    let mut index: AHashMap<String, u32> = AHashMap::default();
    let dict = Array::new();
    let mut idx = Vec::new();
    for v in values {
        idx.push(match v {
            None => MISSING,
            Some(s) => *index.entry(s).or_insert_with_key(|k| {
                dict.push(&JsValue::from_str(k));
                dict.length() - 1
            }),
        });
    }
    let obj = Object::new();
    set(&obj, "dict", &dict);
    set(&obj, "idx", &Uint32Array::from(idx.as_slice()));
    obj.into()
}

fn column(col: &PropColumn, rows: usize) -> Option<JsValue> {
    let f64s = |v: Vec<f64>| -> JsValue { Float64Array::from(v.as_slice()).into() };
    Some(match col.data.as_ref()? {
        VarVec::F32(v) => {
            let data: Vec<f32> = v.iter().map(|x| x.unwrap_or(f32::NAN)).collect();
            Float32Array::from(data.as_slice()).into()
        }
        VarVec::I32(v) => f64s(v.iter().map(|x| x.map_or(f64::NAN, |x| x as f64)).collect()),
        VarVec::U32(v) => f64s(v.iter().map(|x| x.map_or(f64::NAN, |x| x as f64)).collect()),
        VarVec::Bool(v) => {
            let data: Vec<u8> = v.iter().map(|x| x.map_or(2, |b| b as u8)).collect();
            Uint8Array::from(data.as_slice()).into()
        }
        VarVec::U64(v) => dict_column(v.iter().map(|x| x.map(|x| x.to_string()))),
        VarVec::String(v) => dict_column(v.iter().cloned()),
        _ => {
            let _ = rows;
            return None;
        }
    })
}

fn columns(out: DemoOutput) -> JsValue {
    let result = Object::new();
    let cols = Object::new();
    let mut rows = 0usize;
    for info in &out.prop_controller.prop_infos {
        if let Some(col) = out.df.get(&info.id) {
            rows = rows.max(col.len());
            if let Some(v) = column(col, rows) {
                set(&cols, &info.prop_friendly_name, &v);
            }
        }
    }
    set(&result, "rows", &JsValue::from_f64(rows as f64));
    set(&result, "columns", &cols);
    result.into()
}

/// Player props at the given ticks (all ticks when empty), column-wise.
#[wasm_bindgen]
pub fn ticks(props: Vec<String>, ticks: Vec<i32>) -> Result<JsValue, JsError> {
    let out = run(Pass { player_props: props, other_props: vec![], events: vec![], ticks, projectiles: false })?;
    Ok(columns(out))
}

/// Flying grenade projectiles (x, y, z, grenade_type, grenade_entity_id, thrower), column-wise.
#[wasm_bindgen]
pub fn grenades() -> Result<JsValue, JsError> {
    let out = run(Pass { player_props: vec![], other_props: vec![], events: vec![], ticks: vec![], projectiles: true })?;
    Ok(columns(out))
}

/// Voice chat packets (like the Python package's `parse_voice`): `{ticks:
/// Float64Array, steamids: string[], lengths: Uint32Array, data: Uint8Array}`,
/// `data` holding every packet's Opus bytes back to back.
#[wasm_bindgen]
pub fn voice() -> Result<JsValue, JsError> {
    HUFFMAN.with(|huf| {
        let settings = ParserInputs {
            real_name_to_og_name: AHashMap::default(),
            wanted_players: vec![],
            wanted_player_props: vec![],
            wanted_other_props: vec![],
            wanted_prop_states: AHashMap::default(),
            wanted_ticks: vec![],
            wanted_events: vec![],
            parse_ents: false,
            parse_projectiles: false,
            parse_grenades: false,
            only_header: false,
            only_convars: false,
            huffman_lookup_table: huf,
            order_by_steamid: false,
            list_props: false,
            fallback_bytes: None,
        };
        DEMO.with(|d| {
            let bytes = d.borrow();
            if bytes.is_empty() {
                return Err(JsError::new("demo not loaded"));
            }
            let out = Parser::new(settings, ParsingMode::Normal).parse_demo(&bytes).map_err(err)?;
            let (mut ticks, steamids, mut lengths, mut data) = (Vec::new(), Array::new(), Vec::new(), Vec::new());
            for (tick, packet) in &out.voice_data {
                if let Some(audio) = &packet.audio {
                    let payload = audio.voice_data();
                    ticks.push(*tick as f64);
                    steamids.push(&JsValue::from_str(&packet.xuid().to_string()));
                    lengths.push(payload.len() as u32);
                    data.extend_from_slice(payload);
                }
            }
            let obj = Object::new();
            set(&obj, "ticks", &Float64Array::from(ticks.as_slice()));
            set(&obj, "steamids", &steamids);
            set(&obj, "lengths", &Uint32Array::from(lengths.as_slice()));
            set(&obj, "data", &Uint8Array::from(data.as_slice()));
            Ok(obj.into())
        })
    })
}
