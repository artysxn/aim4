//! What aim4 eye can run: the model files and the llama.cpp server build.
//!
//! Everything is pinned. A model is a Hugging Face file at a fixed repository
//! commit with its exact size and SHA-256, and the server is one numbered
//! llama.cpp build with the SHA-256 GitHub publishes for each asset. A
//! download that does not hash to the pinned value is thrown away, never run.
//!
//! The ids are shared with the site (`src/replays/eye/eyePanel.js`
//! EYE_MODELS): the page sends `use-model` with one of them.

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// The vision projector that lets the model read pictures (llama.cpp `--mmproj`).
    pub mmproj_file: &'static str,
    pub mmproj_size: u64,
    pub mmproj_sha256: &'static str,
    /// System memory below which this model is not the recommended one.
    pub min_ram_gb: u64,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}", self.repo, self.revision, self.file)
    }

    pub fn mmproj_url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}", self.repo, self.revision, self.mmproj_file)
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "qwen3.5-2b",
        label: "Tiny (Qwen3.5 2B)",
        repo: "unsloth/Qwen3.5-2B-GGUF",
        revision: "f6d5376be1edb4d416d56da11e5397a961aca8ae",
        file: "Qwen3.5-2B-Q4_K_M.gguf",
        size: 1_280_835_840,
        sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
        mmproj_file: "mmproj-F16.gguf",
        mmproj_size: 668_227_264,
        mmproj_sha256: "7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7",
        min_ram_gb: 0,
    },
    ModelSpec {
        id: "qwen3.5-4b",
        label: "Light (Qwen3.5 4B)",
        repo: "unsloth/Qwen3.5-4B-GGUF",
        revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        size: 2_740_937_888,
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        mmproj_file: "mmproj-F16.gguf",
        mmproj_size: 672_423_616,
        mmproj_sha256: "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864",
        min_ram_gb: 8,
    },
    ModelSpec {
        id: "qwen3.5-9b",
        label: "Standard (Qwen3.5 9B)",
        repo: "unsloth/Qwen3.5-9B-GGUF",
        revision: "3885219b6810b007914f3a7950a8d1b469d598a5",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        size: 5_680_522_464,
        sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        mmproj_file: "mmproj-F16.gguf",
        mmproj_size: 918_166_080,
        mmproj_sha256: "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f",
        min_ram_gb: 16,
    },
    ModelSpec {
        id: "qwen3.5-35b-a3b",
        label: "Large (Qwen3.5 35B-A3B)",
        repo: "unsloth/Qwen3.5-35B-A3B-GGUF",
        revision: "bc014a17be43adabd7066b7a86075ff935c6a4e2",
        file: "Qwen3.5-35B-A3B-Q4_K_M.gguf",
        size: 22_016_023_168,
        sha256: "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375",
        mmproj_file: "mmproj-F16.gguf",
        mmproj_size: 899_283_648,
        mmproj_sha256: "a516ab92e8240da4734d68352bdfba84c16e830ee40010b8fac80d69c77272ff",
        min_ram_gb: 32,
    },
];

pub fn model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// The biggest model this much memory runs comfortably.
pub fn recommended(ram_gb: u64) -> &'static ModelSpec {
    MODELS
        .iter()
        .rev()
        .find(|m| ram_gb >= m.min_ram_gb)
        .unwrap_or(&MODELS[0])
}

/// One llama.cpp server build for one platform.
pub struct ServerBuild {
    pub asset: &'static str,
    pub sha256: &'static str,
    /// A GPU build; when it will not start, the CPU build is the fallback.
    pub gpu: bool,
}

pub const LLAMA_BUILD: &str = "b11706";

impl ServerBuild {
    pub fn url(&self) -> String {
        format!("https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/{}", self.asset)
    }
}

/// The builds for this platform, best first. Empty where there are none.
pub fn server_builds() -> &'static [ServerBuild] {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &[ServerBuild {
            asset: "llama-b11706-bin-macos-arm64.tar.gz",
            sha256: "1ea45e28e460d6591747024856e11ef6db3533211588f4dd4d68671589f76249",
            gpu: true,
        }]
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        &[ServerBuild {
            asset: "llama-b11706-bin-macos-x64.tar.gz",
            sha256: "81d3339bf33254f3e4ddde20bdde11e7589d298efb49992bb4f15e52afc4e5bc",
            gpu: true,
        }]
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        // Vulkan runs on NVIDIA, AMD and Intel GPUs with no CUDA runtime to
        // ship; the CPU build is for machines whose driver cannot start it.
        &[
            ServerBuild {
                asset: "llama-b11706-bin-win-vulkan-x64.zip",
                sha256: "0a3cbd78a90b1a478470ef2eed1a24872625644b4f20fdabe5652cf13977d2fc",
                gpu: true,
            },
            ServerBuild {
                asset: "llama-b11706-bin-win-cpu-x64.zip",
                sha256: "f426ae6d20afeb6970f51cc182dedc3b21cf23ec278192da1af262de43be6115",
                gpu: false,
            },
        ]
    } else {
        &[]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommends_by_memory() {
        assert_eq!(recommended(4).id, "qwen3.5-2b");
        assert_eq!(recommended(8).id, "qwen3.5-4b");
        assert_eq!(recommended(16).id, "qwen3.5-9b");
        assert_eq!(recommended(64).id, "qwen3.5-35b-a3b");
    }

    #[test]
    fn pins_are_whole() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert_eq!(m.mmproj_sha256.len(), 64, "{}", m.id);
            assert!(m.mmproj_url().contains(m.revision));
            assert_eq!(m.revision.len(), 40, "{}", m.id);
            assert!(m.url().contains(m.revision));
        }
    }
}
