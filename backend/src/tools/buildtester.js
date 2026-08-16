const fs = require("fs");
const {
  runCommand,
} = require("./terminal");

async function testProject(projectName) {
  const projectPath =
    require("path").resolve(
      __dirname,
      "../projects",
      projectName
    );

  const packageJsonPath =
    require("path").join(
      projectPath,
      "package.json"
    );

  // ==========================================
  // NO PACKAGE.JSON
  // ==========================================

  if (!fs.existsSync(packageJsonPath)) {
    return {
      success: true,
      skipped: true,
      reason:
        "No package.json found. Static project.",
    };
  }

  // ==========================================
  // READ PACKAGE.JSON
  // ==========================================

  let packageJson;

  try {
    packageJson = JSON.parse(
      fs.readFileSync(
        packageJsonPath,
        "utf8"
      )
    );
  } catch (error) {
    return {
      success: false,
      skipped: false,
      command: "package.json",
      stdout: "",
      stderr:
        "Invalid package.json: " +
        error.message,
      exitCode: -1,
    };
  }

  // ==========================================
  // INSTALL DEPENDENCIES
  // ==========================================

  console.log(
    "📦 Installing dependencies..."
  );

  const installResult =
    await runCommand(
      projectName,
      "npm",
      ["install"]
    );

  if (!installResult.success) {
    return {
      ...installResult,
      stage: "npm install",
    };
  }

  // ==========================================
  // DETERMINE TEST COMMAND
  // ==========================================

  const scripts =
    packageJson.scripts || {};

  let command = null;

  if (scripts.build) {
    command = "build";
  } else if (scripts.test) {
    command = "test";
  }

  // ==========================================
  // NO BUILD/TEST SCRIPT
  // ==========================================

  if (!command) {
    return {
      success: true,
      skipped: true,
      reason:
        "Dependencies installed, but no build/test script exists.",
    };
  }

  // ==========================================
  // RUN BUILD / TEST
  // ==========================================

  console.log(
    `🧪 Running npm run ${command}...`
  );

  const testResult =
    await runCommand(
      projectName,
      "npm",
      ["run", command]
    );

  return {
    ...testResult,
    stage: `npm run ${command}`,
  };
}

module.exports = {
  testProject,
};
