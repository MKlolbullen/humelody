cmake_minimum_required(VERSION 3.24)
project(Humline VERSION 0.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(HUMLINE_BUILD_PLUGIN "Build the JUCE plug-in and standalone app" ON)
add_executable(HumlineTrackerTests ../tests/tracker-native.cpp)
enable_testing()
add_test(NAME detector COMMAND HumlineTrackerTests)
if(NOT HUMLINE_BUILD_PLUGIN)
  return()
endif()
include(FetchContent)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE/CMakeLists.txt")
  set(FETCHCONTENT_SOURCE_DIR_JUCE "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE" CACHE PATH "Bundled JUCE source")
endif()
FetchContent_Declare(JUCE
  URL https://codeload.github.com/juce-framework/JUCE/tar.gz/72782788ce18c2d4d760b28e0921d6ffc6431102
  URL_HASH SHA256=28ec8ae0626a4d1c6ca8c32ad13f95868b147779d4f3df4a7868f333a38e0551
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(JUCE)
set(HUMLINE_FORMATS VST3 Standalone)
if(APPLE)
  list(APPEND HUMLINE_FORMATS AU)
endif()
juce_add_plugin(Humline
  COMPANY_NAME "Victor Ahgren" BUNDLE_ID "com.victorahgren.humline"
  PLUGIN_MANUFACTURER_CODE Vahg PLUGIN_CODE Huml
  FORMATS ${HUMLINE_FORMATS} PRODUCT_NAME "Humline"
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Humline uses your microphone to turn singing and humming into MIDI notes."
  IS_SYNTH FALSE NEEDS_MIDI_INPUT TRUE NEEDS_MIDI_OUTPUT TRUE IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE COPY_PLUGIN_AFTER_BUILD FALSE
  VST3_CATEGORIES Fx Tools)
target_sources(Humline PRIVATE Plugin.cpp Tracker.h)
target_compile_definitions(Humline PUBLIC JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(Humline PRIVATE juce::juce_audio_utils PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(HumlineProcessorTests ../tests/processor-native.cpp)
target_include_directories(HumlineProcessorTests PRIVATE $<TARGET_PROPERTY:Humline,INCLUDE_DIRECTORIES>)
target_compile_definitions(HumlineProcessorTests PRIVATE $<TARGET_PROPERTY:Humline,COMPILE_DEFINITIONS>)
target_link_libraries(HumlineProcessorTests PRIVATE Humline)
add_test(NAME processor COMMAND HumlineProcessorTests)
