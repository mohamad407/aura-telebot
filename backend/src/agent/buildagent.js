const {
  testProject,
} = require("../tools/buildTester");

const {
  createFixPlan,
} = require("./planner");

const {
  executeFixPlan,
} = require("./executor");

const {
  getProjectFiles,
} = require("../tools/filesystem");

const MAX_ATTEMPTS = 3;

async function runBuildAgent(projectName) {
  console.log("\n🏗️ AURA BUILD AGENT");
  console.log("📁 Project:", projectName);

  let buildResult;
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;

    console.log(
      `\n🧪 Build attempt ${attempts}/${MAX_ATTEMPTS}`
    );

    // ==========================================
    // RUN BUILD
    // ==========================================

    buildResult =
      await testProject(projectName);

    console.log(
      "\n📋 Build result:"
    );

    console.log(
      JSON.stringify(
        buildResult,
        null,
        2
      )
    );

    // ==========================================
    // BUILD SUCCESS
    // ==========================================

    if (buildResult.success) {
      console.log(
        "\n🎉 BUILD SUCCESSFUL!"
      );

      return {
        success: true,
        attempts,
        buildResult,
      };
    }

    // ==========================================
    // BUILD FAILED
    // ==========================================

    console.log(
      "\n❌ BUILD FAILED"
    );

    console.log(
      "🧠 Sending error to Groq..."
    );

    // ==========================================
    // READ PROJECT
    // ==========================================

    const files =
      getProjectFiles(projectName);

    // ==========================================
    // ASK GROQ FOR FIX
    // ==========================================

    const fixPlan =
      await createFixPlan({
        userRequest:
          "Fix the build error in this project.",

        projectName,

        files,

        errorOutput: {
          stage:
            buildResult.stage,

          command:
            buildResult.command,

          stdout:
            buildResult.stdout,

          stderr:
            buildResult.stderr,

          exitCode:
            buildResult.exitCode,
        },
      });

    console.log(
      "\n🧠 Groq diagnosis:"
    );

    console.log(
      fixPlan.reason
    );

    console.log(
      "\n🔧 Fix plan:"
    );

    console.log(
      JSON.stringify(
        fixPlan,
        null,
        2
      )
    );

    // ==========================================
    // APPLY FIX
    // ==========================================

    console.log(
      "\n✍️ Applying fix..."
    );

    const fixResult =
      await executeFixPlan(
        projectName,
        fixPlan
      );

    console.log(
      "✅ Fix result:"
    );

    console.log(
      fixResult.results
    );
  }

  // ==========================================
  // MAX ATTEMPTS REACHED
  // ==========================================

  console.log(
    "\n❌ Aura could not fix the build."
  );

  return {
    success: false,
    attempts,
    buildResult,
  };
}

module.exports = {
  runBuildAgent,
};
