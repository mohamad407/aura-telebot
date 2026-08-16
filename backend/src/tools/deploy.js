const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==========================================
// RUN WINDOWS COMMAND
// ==========================================

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            message: error.message,
            stdout: stdout || "",
            stderr: stderr || "",
            code: error.code,
          });

          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

// ==========================================
// FIND VERCEL CLI
// ==========================================

function getVercelCommand() {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ||
      path.join(
        process.env.USERPROFILE || "",
        "AppData",
        "Roaming"
      );

    const vercelPath = path.join(
      appData,
      "npm",
      "vercel.cmd"
    );

    if (fs.existsSync(vercelPath)) {
      return `"${vercelPath}"`;
    }

    return "vercel.cmd";
  }

  return "vercel";
}

// ==========================================
// EXTRACT VERCEL URL
// ==========================================

function extractVercelUrl(output) {
  const matches = output.match(
    /https:\/\/[a-zA-Z0-9.-]+\.vercel\.app/g
  );

  if (!matches || matches.length === 0) {
    return null;
  }

  // Remove duplicates
  const uniqueUrls = [...new Set(matches)];

  return uniqueUrls[uniqueUrls.length - 1];
}

// ==========================================
// DEPLOY TO VERCEL
// ==========================================

async function deployToVercel(projectPath) {
  console.log("\n🚀 AURA DEPLOY AGENT");

  console.log(
    "📁 Project:",
    projectPath
  );

  try {
    // ========================================
    // CHECK PROJECT
    // ========================================

    if (!fs.existsSync(projectPath)) {
      return {
        success: false,
        url: null,
        output: "",
        error:
          "Project directory does not exist.",
      };
    }

    // ========================================
    // FIND VERCEL
    // ========================================

    const vercelCommand =
      getVercelCommand();

    console.log(
      "🔎 Vercel CLI:",
      vercelCommand
    );

    // ========================================
    // DEPLOY
    // ========================================

    console.log(
      "🚀 Deploying to Vercel..."
    );

    const command =
      `${vercelCommand} --prod --yes`;

    console.log(
      "⚙️ Running:",
      command
    );

    const result =
      await runCommand(
        command,
        projectPath
      );

    const output =
      `${result.stdout}\n${result.stderr}`;

    console.log(
      "\n📋 Vercel output:"
    );

    console.log(output);

    // ========================================
    // FIND LIVE URL
    // ========================================

    const url =
      extractVercelUrl(output);

    if (!url) {
      console.log(
        "⚠️ Vercel deployment finished but URL was not detected."
      );

      return {
        success: false,
        url: null,
        output,
        error:
          "Vercel URL could not be detected.",
      };
    }

    // ========================================
    // SUCCESS
    // ========================================

    console.log(
      "\n🎉 DEPLOYMENT SUCCESSFUL!"
    );

    console.log(
      "🌐 Live URL:",
      url
    );

    return {
      success: true,
      url,
      output,
      error: null,
    };

  } catch (error) {
    // ========================================
    // ERROR
    // ========================================

    console.error(
      "\n❌ Deployment failed:"
    );

    console.error(error);

    return {
      success: false,
      url: null,
      output:
        `${error.stdout || ""}\n${error.stderr || ""}`,
      error:
        error.message ||
        "Unknown deployment error",
    };
  }
}

module.exports = {
  deployToVercel,
};
