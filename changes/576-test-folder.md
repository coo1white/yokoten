Fixed

A test folder counts only when that language's own test files are in the project. An OpenAPI `spec/` folder is not a passing test suite (#576).
Maven and Gradle count Surefire names such as `TestFoo.java`, `TestFoo.kt` and `FooTestCase.java`. A `Test` prefix counts under `src/test` only.
Gradle also counts `@Test` and a Kotest `StringSpec` under `src/test`. Maven keeps the Surefire names.
Rust counts `#[tokio::test]`, `#[async_std::test]` and `#[rstest]`.
.NET counts a source file that holds a test attribute such as `[Fact]`. The same text in a comment, a string, an indexer or a collection does not count.
