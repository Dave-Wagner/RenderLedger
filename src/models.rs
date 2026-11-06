use std::{fs, io, path::PathBuf};

pub fn generate() -> io::Result<Vec<PathBuf>> {
    fs::create_dir_all("models")?;
    [
        ("conv-small", 32, 16),
        ("conv-wide", 64, 32),
        ("conv-large", 128, 64),
    ]
    .into_iter()
    .map(|(name, side, channels)| write_model(name, side, channels))
    .collect()
}

fn write_model(name: &str, side: usize, channels: usize) -> io::Result<PathBuf> {
    let xml = PathBuf::from("models").join(format!("{name}.xml"));
    let weights = channels * 3 * 3 * 3;
    let size = weights * size_of::<f32>();
    let input = format!("<dim>1</dim><dim>3</dim><dim>{side}</dim><dim>{side}</dim>");
    let output = format!("<dim>1</dim><dim>{channels}</dim><dim>{side}</dim><dim>{side}</dim>");
    let kernel = format!("<dim>{channels}</dim><dim>3</dim><dim>3</dim><dim>3</dim>");
    let graph = format!(
        r#"<?xml version="1.0"?>
<net name="{name}" version="11">
  <layers>
    <layer id="0" name="image" type="Parameter" version="opset1">
      <data shape="1,3,{side},{side}" element_type="f32"/>
      <output><port id="0" precision="FP32" names="image">{input}</port></output>
    </layer>
    <layer id="1" name="kernel" type="Const" version="opset1">
      <data element_type="f32" shape="{channels},3,3,3" offset="0" size="{size}"/>
      <output><port id="0" precision="FP32">{kernel}</port></output>
    </layer>
    <layer id="2" name="conv" type="Convolution" version="opset1">
      <data strides="1,1" dilations="1,1" pads_begin="1,1" pads_end="1,1" auto_pad="explicit"/>
      <input><port id="0">{input}</port><port id="1">{kernel}</port></input>
      <output><port id="2" precision="FP32">{output}</port></output>
    </layer>
    <layer id="3" name="relu" type="ReLU" version="opset1">
      <input><port id="0">{output}</port></input>
      <output><port id="1" precision="FP32" names="activation">{output}</port></output>
    </layer>
    <layer id="4" name="result" type="Result" version="opset1">
      <input><port id="0">{output}</port></input>
    </layer>
  </layers>
  <edges>
    <edge from-layer="0" from-port="0" to-layer="2" to-port="0"/>
    <edge from-layer="1" from-port="0" to-layer="2" to-port="1"/>
    <edge from-layer="2" from-port="2" to-layer="3" to-port="0"/>
    <edge from-layer="3" from-port="1" to-layer="4" to-port="0"/>
  </edges>
</net>
"#
    );
    let bytes: Vec<u8> = (0..weights)
        .flat_map(|index| (((index % 23) as f32 - 11.0) / 128.0).to_le_bytes())
        .collect();
    fs::write(xml.with_extension("bin"), bytes)?;
    fs::write(&xml, graph)?;
    Ok(xml)
}
