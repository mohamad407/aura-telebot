const { exec } = require("child_process");
const path = require("path");

function runCommand(projectName, command, args = []) {
  return new Promise((resolve) => {
    const projectPath = path.resolve(
      __dirname,
      "../projects",
      projectName
    );

    const fullCommand =
      `${command} ${args.join(" ")}`;

    console.log(
      `⚙️ Running: ${fullCommand}`
    );

    exec(
      fullCommand,
      {
        cwd: projectPath,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            command: fullCommand,
            stdout: stdout || "",
            stderr:
              stderr ||
              error.message ||
              "Command failed.",
            exitCode:
              typeof error.code === "number"
                ? error.code
                : 1,
          });

          return;
        }

        resolve({
          success: true,
          command: fullCommand,
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: 0,
        });
      }
    );
  });
}

module.exports = {
  runCommand,
};
