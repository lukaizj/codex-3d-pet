use std::{
    fs,
    sync::{Arc, Mutex},
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, Size, State as TauriState,
};
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_window_state::StateFlags;

const BRIDGE_PORT: u16 = 38241;
const MAX_MESSAGE_LENGTH: usize = 280;
const MAX_TTL_SECONDS: u32 = 3_600;

#[derive(Clone)]
struct BridgeState {
    secret: String,
    status: Arc<Mutex<PetStatus>>,
    app: AppHandle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetStatus {
    connected: bool,
    persona_selected: bool,
    current_state: String,
    message: Option<String>,
    event_id: Option<String>,
}

impl Default for PetStatus {
    fn default() -> Self {
        Self {
            connected: true,
            persona_selected: false,
            current_state: "idle".into(),
            message: None,
            event_id: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetEvent {
    version: u8,
    id: String,
    state: String,
    message: Option<String>,
    ttl_seconds: Option<u32>,
    created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PetMessage {
    message: String,
    severity: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeInfo {
    url: String,
    secret: String,
}

fn valid_state(state: &str) -> bool {
    matches!(
        state,
        "idle" | "thinking" | "working" | "needs_attention" | "completed" | "error"
    )
}

fn authorized(headers: &HeaderMap, state: &BridgeState) -> bool {
    headers
        .get("x-codex-pet-secret")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == state.secret)
}

async fn status_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Json<PetStatus>, StatusCode> {
    if !authorized(&headers, &state) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let status = state
        .status
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();
    Ok(Json(status))
}

async fn event_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(event): Json<PetEvent>,
) -> Result<StatusCode, StatusCode> {
    if !authorized(&headers, &state) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    if event.version != 1
        || !valid_state(&event.state)
        || event.id.is_empty()
        || event
            .message
            .as_ref()
            .is_some_and(|message| message.len() > MAX_MESSAGE_LENGTH)
        || event
            .ttl_seconds
            .is_some_and(|ttl| ttl == 0 || ttl > MAX_TTL_SECONDS)
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    {
        let mut status = state
            .status
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        status.current_state = event.state.clone();
        status.message = event.message.clone();
        status.event_id = Some(event.id.clone());
    }

    state
        .app
        .emit("pet://event", event)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn message_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(message): Json<PetMessage>,
) -> Result<StatusCode, StatusCode> {
    if !authorized(&headers, &state) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    if message.message.trim().is_empty() || message.message.len() > MAX_MESSAGE_LENGTH {
        return Err(StatusCode::BAD_REQUEST);
    }

    {
        let mut status = state
            .status
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        status.message = Some(message.message.clone());
    }

    state
        .app
        .emit("pet://message", message)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn start_bridge(state: BridgeState) {
    let router = Router::new()
        .route("/status", get(status_handler))
        .route("/event", post(event_handler))
        .route("/message", post(message_handler))
        .with_state(state);

    match tokio::net::TcpListener::bind(("127.0.0.1", BRIDGE_PORT)).await {
        Ok(listener) => {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("Codex 桌宠本地连接桥已停止：{error}");
            }
        }
        Err(error) => eprintln!("无法将 Codex 桌宠本地连接桥绑定到回环地址：{error}"),
    }
}

#[tauri::command]
fn bridge_info(state: TauriState<'_, BridgeState>) -> BridgeInfo {
    BridgeInfo {
        url: format!("http://127.0.0.1:{BRIDGE_PORT}"),
        secret: state.secret.clone(),
    }
}

#[tauri::command]
fn set_persona_selected(selected: bool, state: TauriState<'_, BridgeState>) -> Result<(), String> {
    let mut status = state
        .status
        .lock()
        .map_err(|_| "桌宠状态暂不可用".to_string())?;
    status.persona_selected = selected;
    Ok(())
}

#[tauri::command]
fn set_click_through(enabled: bool, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主桌宠窗口不可用".to_string())?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("无法更新鼠标穿透设置：{error}"))
}

/// 把用户选中的 VRM 复制到应用目录，避免 macOS 沙箱/权限导致再次读取失败。
#[tauri::command]
fn import_vrm(source_path: String, app: AppHandle) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    if !source.is_file() {
        return Err("所选的 VRM 文件不存在。".into());
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "vrm" {
        return Err("请选择 .vrm 文件。".into());
    }

    let bytes = fs::read(source).map_err(|error| format!("无法读取 VRM 文件：{error}"))?;
    if bytes.is_empty() {
        return Err("VRM 文件为空。".into());
    }
    if bytes.len() > 200 * 1024 * 1024 {
        return Err("VRM 文件过大（超过 200MB）。".into());
    }

    let personas_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法访问应用数据目录：{error}"))?
        .join("personas");
    fs::create_dir_all(&personas_dir)
        .map_err(|error| format!("无法创建角色目录：{error}"))?;

    let file_name = format!(
        "{}.vrm",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    );
    let destination = personas_dir.join(file_name);
    fs::write(&destination, &bytes).map_err(|error| format!("无法保存 VRM 文件：{error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// 直接读本地 VRM 字节，供前端用 Blob/parse 加载（绕过 asset 协议问题）。
#[tauri::command]
fn read_vrm_bytes(path: String) -> Result<Response, String> {
    let file = std::path::Path::new(&path);
    if !file.is_file() {
        return Err("角色文件不存在。请重新导入 VRM。".into());
    }
    let bytes = fs::read(file).map_err(|error| format!("无法读取角色文件：{error}"))?;
    if bytes.is_empty() {
        return Err("角色文件为空。请重新导入 VRM。".into());
    }
    Ok(Response::new(bytes))
}

fn random_secret() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn load_or_create_secret(app: &AppHandle) -> String {
    let directory = app.path().app_config_dir().ok();
    let path = directory
        .as_ref()
        .map(|directory| directory.join("bridge-secret"));

    if let Some(path) = path {
        if let Ok(secret) = fs::read_to_string(&path) {
            let secret = secret.trim().to_string();
            if !secret.is_empty() {
                return secret;
            }
        }

        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let secret = random_secret();
        if fs::write(&path, format!("{secret}\n")).is_ok() {
            return secret;
        }
    }

    random_secret()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        // 桌宠每次默认小窗开在右下角，不恢复旧的大尺寸/坐标
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            let bridge = BridgeState {
                secret: load_or_create_secret(&app.handle()),
                status: Arc::new(Mutex::new(PetStatus::default())),
                app: app.handle().clone(),
            };

            let show = MenuItem::with_id(app, "show", "显示桌宠", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏桌宠", true, None::<&str>)?;
            let open_settings =
                MenuItem::with_id(app, "open_settings", "打开设置", true, None::<&str>)?;
            let restore_input =
                MenuItem::with_id(app, "restore_input", "恢复鼠标交互", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &hide, &open_settings, &restore_input, &quit],
            )?;
            let tray_handle = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |_tray, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "open_settings" => {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.set_ignore_cursor_events(false);
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = tray_handle.emit("pet://open-settings", ());
                        }
                    }
                    "restore_input" => {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.set_ignore_cursor_events(false);
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = tray_handle.emit("pet://input-restored", ());
                        }
                    }
                    "quit" => tray_handle.exit(0),
                    _ => {}
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(false);
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = window.set_size(Size::Logical(LogicalSize::new(220.0, 300.0)));
                let _ = window.move_window(Position::BottomRight);
            }

            let bridge_for_server = bridge.clone();
            app.manage(bridge);
            tauri::async_runtime::spawn(start_bridge(bridge_for_server));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_info,
            set_persona_selected,
            set_click_through,
            import_vrm,
            read_vrm_bytes
        ])
        .run(tauri::generate_context!())
        .expect("运行 Codex 3D 桌宠时发生错误");
}
