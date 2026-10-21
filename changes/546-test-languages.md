Added

`yokoten doctor` and `yokoten adopt` now find the test command of .NET, Ruby, PHP, Swift, Elixir, Dart and Flutter projects. A Makefile with a test target counts too. In CI, `dotnet test`, `bundle exec rspec`, `vendor/bin/phpunit`, `swift test`, `mix test`, `dart test` and `flutter test` now count as running the tests. Both commands read one table, so they name the same command (#546).
