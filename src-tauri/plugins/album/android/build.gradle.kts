import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.tuzkimo.weefuse.album"
    // ★ 下面几个值**以 `gen/android/app/build.gradle.kts` 的实际值为准**（2026-10-06 任务 2 实读）：
    //   compileSdk = 37 / targetSdk = 37 / minSdk = 29 / JavaVersion.VERSION_1_8 / JvmTarget.JVM_1_8。
    // AGP 要求同一工程里所有 module 的 compileSdk 与 JVM target 一致，不一致会明确报错。
    // 计划正文给的 36 / `kotlinOptions { jvmTarget = "1.8" }` 是模板相关值与旧 DSL（本仓 app 模块
    // 已用 `kotlin { compilerOptions { jvmTarget = … } }`），照抄会与 app 模块冲突，已按实读对齐。
    compileSdk = 37
    defaultConfig {
        minSdk = 29
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation(project(":tauri-android"))
}
