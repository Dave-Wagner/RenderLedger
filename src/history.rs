use rusqlite::{Connection, params};
use serde_json::{Value, json};

type Result<T> = rusqlite::Result<T>;

fn media_db() -> Result<Connection> {
    let db = open()?;
    init_media(&db)?;
    Ok(db)
}

fn init_media(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_runs (
            id INTEGER PRIMARY KEY, created TEXT NOT NULL DEFAULT (datetime('now')),
            result TEXT NOT NULL
        )",
    )
}

pub fn save_media(result: &Value) -> Result<Value> {
    let db = media_db()?;
    db.execute("INSERT INTO media_runs (result) VALUES (?1)", [result.to_string()])?;
    let mut result = result.clone();
    result["id"] = json!(db.last_insert_rowid());
    Ok(result)
}

pub fn media_list() -> Result<Value> {
    media_list_for("")
}

pub fn media_list_for(category: &str) -> Result<Value> {
    let db = media_db()?;
    let mut statement = db.prepare(
        "SELECT id, created, json_remove(result, '$.audio') FROM media_runs
         WHERE ?1 = '' OR CASE json_extract(result, '$.source')
           WHEN 'local-video' THEN 'video'
           WHEN 'local-music' THEN 'music'
           WHEN 'eleven-music' THEN 'music'
           WHEN 'runpod-music' THEN 'music'
           ELSE 'speech' END = ?1
         ORDER BY id DESC LIMIT 30",
    )?;
    let rows = statement.query_map([category], |row| {
        let mut result: Value = serde_json::from_str(&row.get::<_, String>(2)?)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        result["id"] = json!(row.get::<_, i64>(0)?);
        result["created"] = json!(row.get::<_, String>(1)?);
        Ok(result)
    })?;
    Ok(json!(rows.collect::<Result<Vec<_>>>()?))
}

pub fn media_get(id: i64) -> Result<Value> {
    let result: String = media_db()?.query_row(
        "SELECT result FROM media_runs WHERE id = ?1", [id], |row| row.get(0),
    )?;
    let mut result: Value = serde_json::from_str(&result)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    result["id"] = json!(id);
    Ok(result)
}

pub fn media_replay(settings: &Value) -> Result<Value> {
    let id = exact_media_id(&media_db()?, settings)?;
    media_get(id)
}

fn exact_media_id(db: &Connection, settings: &Value) -> Result<i64> {
    db.query_row(
        "SELECT id FROM media_runs WHERE json_extract(result, '$.settings') = ?1 ORDER BY id DESC LIMIT 1",
        [settings.to_string()], |row| row.get(0),
    )
}

#[cfg(test)]
#[test]
fn replay_uses_newest_exact_match_and_accepts_legacy_history() -> Result<()> {
    let db = Connection::open_in_memory()?;
    init_media(&db)?;
    let settings = json!({"model": "speech", "text": "Hello", "voice": "a"});
    let result = json!({"settings": settings});
    db.execute("INSERT INTO media_runs (result) VALUES ('{}'), (?1), (?1)", [result.to_string()])?;
    assert_eq!(exact_media_id(&db, &settings)?, 3);
    let other_voice = json!({"model": "speech", "text": "Hello", "voice": "b"});
    assert!(matches!(exact_media_id(&db, &other_voice), Err(rusqlite::Error::QueryReturnedNoRows)));
    Ok(())
}

pub fn record_chat_usage(device: &str, output: &str) -> Result<()> {
    let output: Value = serde_json::from_str(output)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let db = open()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_usage (
            id INTEGER PRIMARY KEY, created TEXT NOT NULL DEFAULT (datetime('now')),
            model TEXT NOT NULL, device TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER
        )",
    )?;
    db.execute(
        "INSERT INTO chat_usage (model, device, input_tokens, output_tokens) VALUES (?1, ?2, ?3, ?4)",
        params![output["model"].as_str().unwrap_or("Qwen2 0.5B Instruct INT4"), device,
                output["inputTokens"].as_i64(), output["tokens"].as_i64()],
    )?;
    Ok(())
}

fn open() -> Result<Connection> {
    let path = std::env::var_os("NPU_LAB_DB").unwrap_or_else(|| "npu-lab.sqlite3".into());
    let db = Connection::open(path)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS image_runs (
            id INTEGER PRIMARY KEY,
            created TEXT NOT NULL DEFAULT (datetime('now')),
            kind TEXT NOT NULL,
            device TEXT NOT NULL,
            model TEXT NOT NULL,
            request TEXT NOT NULL,
            result TEXT,
            error TEXT
        )",
    )?;
    Ok(db)
}

pub fn start(kind: &str, device: &str, input: &[u8]) -> std::io::Result<i64> {
    let mut request: Value = serde_json::from_slice(input)?;
    let settings = request
        .as_object_mut()
        .ok_or_else(|| std::io::Error::other("Invalid run settings."))?;
    settings.retain(|key, _| {
        matches!(
            key.as_str(),
            "prompt" | "negativePrompt" | "seed" | "steps" | "strength" | "reference" | "batch"
        )
    });
    let model = if device == "Colab" {
        "SDXL Turbo"
    } else {
        "Stable Diffusion 1.5 INT8"
    };
    insert(kind, device, model, &request).map_err(std::io::Error::other)
}

fn insert(kind: &str, device: &str, model: &str, request: &Value) -> Result<i64> {
    let db = open()?;
    db.execute(
        "INSERT INTO image_runs (kind, device, model, request) VALUES (?1, ?2, ?3, ?4)",
        params![kind, device, model, request.to_string()],
    )?;
    Ok(db.last_insert_rowid())
}

pub fn finish(id: i64, result: &std::io::Result<String>) -> Result<()> {
    let (output, error) = match result {
        Ok(output) => (Some(output.as_str()), None),
        Err(error) => (None, Some(error.to_string())),
    };
    open()?.execute(
        "UPDATE image_runs SET result = ?1, error = ?2 WHERE id = ?3",
        params![output, error, id],
    )?;
    Ok(())
}

pub fn list() -> Result<Value> {
    let db = open()?;
    let mut query = db.prepare(
        "SELECT id, created, kind, device, model, json_extract(request, '$.prompt'),
                CASE WHEN result IS NOT NULL THEN 'Saved'
                     WHEN error IS NOT NULL THEN 'Error' ELSE 'Incomplete' END,
                json_extract(request, '$.batch')
         FROM image_runs ORDER BY id DESC",
    )?;
    let rows = query.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?, "created": row.get::<_, String>(1)?,
            "kind": row.get::<_, String>(2)?, "device": row.get::<_, String>(3)?,
            "model": row.get::<_, String>(4)?, "prompt": row.get::<_, Option<String>>(5)?,
            "status": row.get::<_, String>(6)?, "batch": row.get::<_, Option<String>>(7)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>>>()?))
}

pub fn get(id: i64) -> Result<Value> {
    open()?.query_row(
        "SELECT device, model, request, result, error FROM image_runs WHERE id = ?1",
        [id],
        |row| {
            let request: String = row.get(2)?;
            let result: Option<String> = row.get(3)?;
            Ok(json!({
                "id": id, "device": row.get::<_, String>(0)?, "model": row.get::<_, String>(1)?,
                "request": serde_json::from_str::<Value>(&request).unwrap_or_default(),
                "result": result.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "error": row.get::<_, Option<String>>(4)?,
            }))
        },
    )
}
