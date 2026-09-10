use zed_extension_api as zed;

struct CodeInspectionExtension;

impl zed::Extension for CodeInspectionExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let command = worktree
            .which("code-inspection-lsp")
            .ok_or_else(|| "code-inspection-lsp was not found on PATH. Install @zakotoys/code-inspection-runtime and expose its bin directory before starting Zed.".to_string())?;
        Ok(zed::Command {
            command,
            args: Vec::new(),
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(CodeInspectionExtension);
