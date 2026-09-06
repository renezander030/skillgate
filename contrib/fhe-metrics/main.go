// Command fhe-metrics privately aggregates Skillgate gate counts.
//
// Users normally reach it through `skillgate fhe-metrics`. Keeping the FHE
// evaluator in this small Go module avoids pretending that TFHE's JavaScript
// client-only API can perform homomorphic computation.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	var code int
	switch os.Args[1] {
	case "keygen":
		code = commandKeygen(os.Args[2:])
	case "encrypt":
		code = commandEncrypt(os.Args[2:])
	case "aggregate":
		code = commandAggregate(os.Args[2:])
	case "decrypt":
		code = commandDecrypt(os.Args[2:])
	case "help", "-h", "--help":
		printUsage()
		code = 0
	default:
		fmt.Fprintf(os.Stderr, "unknown fhe-metrics command %q\n", os.Args[1])
		printUsage()
		code = 2
	}
	os.Exit(code)
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  skillgate fhe-metrics keygen [--secret .skillgate/fhe-metrics-secret.json] [--public .skillgate/fhe-metrics-public.json]")
	fmt.Fprintln(os.Stderr, "  skillgate check --json | skillgate fhe-metrics encrypt --public <key.json> --context <value> --repository <random-token> --out <metric.json>")
	fmt.Fprintln(os.Stderr, "  skillgate fhe-metrics aggregate --public <key.json> --context <value> --out <aggregate.json> <metric.json>...")
	fmt.Fprintln(os.Stderr, "  skillgate fhe-metrics decrypt --secret <key.json> --context <value> --expected <n> --minimum-percent <0..100> <aggregate.json>")
}

func commandKeygen(args []string) int {
	flags := flag.NewFlagSet("fhe-metrics keygen", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	secretPath := flags.String("secret", ".skillgate/fhe-metrics-secret.json", "secret decryption key path")
	publicPath := flags.String("public", ".skillgate/fhe-metrics-public.json", "shareable encryption key path")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || resolveCallerPath(*secretPath) == resolveCallerPath(*publicPath) {
		fmt.Fprintln(os.Stderr, "keygen requires different --secret and --public paths and no positional arguments")
		return 2
	}
	secret, public, err := generateFHEKeys()
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate FHE keys: %v\n", err)
		return 1
	}
	secretJSON, err := marshalFHE(secret)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode secret key: %v\n", err)
		return 1
	}
	publicJSON, err := marshalFHE(public)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode public key: %v\n", err)
		return 1
	}
	resolvedSecret, resolvedPublic := resolveCallerPath(*secretPath), resolveCallerPath(*publicPath)
	if err := writeFHEExclusive(resolvedSecret, append(secretJSON, '\n'), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write secret key: %v\n", err)
		return 1
	}
	if err := writeFHEExclusive(resolvedPublic, append(publicJSON, '\n'), 0o644); err != nil {
		_ = os.Remove(resolvedSecret)
		fmt.Fprintf(os.Stderr, "write public key: %v\n", err)
		return 1
	}
	if err := ensureSecretIgnored(); err != nil {
		_ = os.Remove(resolvedSecret)
		_ = os.Remove(resolvedPublic)
		fmt.Fprintf(os.Stderr, "protect secret key in .gitignore: %v\n", err)
		return 1
	}
	fmt.Printf("created encrypted-metrics keys; share %s and keep %s private\n", *publicPath, *secretPath)
	fmt.Printf("key ID: %s\n", public.KeyID)
	return 0
}

func commandEncrypt(args []string) int {
	flags := flag.NewFlagSet("fhe-metrics encrypt", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	publicPath := flags.String("public", ".skillgate/fhe-metrics-public.json", "shareable encryption key path")
	context := flags.String("context", "", "aggregation period/policy context; only its hash is stored")
	repository := flags.String("repository", "", "unique random repository token; only its hash is stored")
	outputPath := flags.String("out", "", "encrypted repository metric path")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *context == "" || *repository == "" || *outputPath == "" {
		fmt.Fprintln(os.Stderr, "usage: skillgate check --json | skillgate fhe-metrics encrypt --public <key.json> --context <value> --repository <random-token> --out <metric.json>")
		return 2
	}
	checkJSON, err := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	if err != nil || len(strings.TrimSpace(string(checkJSON))) == 0 {
		fmt.Fprintln(os.Stderr, "encrypt requires a Skillgate `check --json` report on stdin")
		return 2
	}
	public, err := readFHEPublic(*publicPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	metric, err := encryptCheckReport(public, *context, *repository, checkJSON)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encrypt Skillgate metrics: %v\n", err)
		return 1
	}
	encoded, err := marshalFHE(metric)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode encrypted metric: %v\n", err)
		return 1
	}
	if err := writeFHEExclusive(resolveCallerPath(*outputPath), append(encoded, '\n'), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write encrypted metric: %v\n", err)
		return 1
	}
	fmt.Printf("encrypted this repository's gate counts to %s; no readable PASS/failure counts were written\n", *outputPath)
	return 0
}

func commandAggregate(args []string) int {
	flags := flag.NewFlagSet("fhe-metrics aggregate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	publicPath := flags.String("public", ".skillgate/fhe-metrics-public.json", "pinned encryption key path")
	context := flags.String("context", "", "aggregation period/policy context")
	outputPath := flags.String("out", "", "encrypted fleet aggregate path")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *context == "" || *outputPath == "" || flags.NArg() < minRepositories {
		fmt.Fprintf(os.Stderr, "aggregate requires --context, --out, and at least %d metric files\n", minRepositories)
		return 2
	}
	public, err := readFHEPublic(*publicPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	metrics := make([]encryptedMetric, 0, flags.NArg())
	for _, path := range flags.Args() {
		data, err := os.ReadFile(resolveCallerPath(path)) // #nosec G304 -- explicit CLI input.
		if err != nil {
			fmt.Fprintf(os.Stderr, "read encrypted metric %s: %v\n", path, err)
			return 1
		}
		metric, err := parseEncryptedMetric(data)
		if err != nil {
			fmt.Fprintf(os.Stderr, "parse encrypted metric %s: %v\n", path, err)
			return 1
		}
		metrics = append(metrics, metric)
	}
	aggregate, err := aggregateMetrics(public, *context, metrics)
	if err != nil {
		fmt.Fprintf(os.Stderr, "aggregate encrypted metrics: %v\n", err)
		return 1
	}
	encoded, err := marshalFHE(aggregate)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode encrypted aggregate: %v\n", err)
		return 1
	}
	if err := writeFHEExclusive(resolveCallerPath(*outputPath), append(encoded, '\n'), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write encrypted aggregate: %v\n", err)
		return 1
	}
	fmt.Printf("combined %d repositories into %s without decrypting any gate count\n", aggregate.Repositories, *outputPath)
	return 0
}

func commandDecrypt(args []string) int {
	flags := flag.NewFlagSet("fhe-metrics decrypt", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	secretPath := flags.String("secret", ".skillgate/fhe-metrics-secret.json", "secret decryption key path")
	context := flags.String("context", "", "aggregation period/policy context")
	expected := flags.Int("expected", 0, "exact number of repository reports expected")
	minimum := flags.Float64("minimum-percent", -1, "minimum fleet gate pass percentage")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *context == "" || *expected < minRepositories || *minimum < 0 || *minimum > 100 || flags.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: skillgate fhe-metrics decrypt --secret <key.json> --context <value> --expected <n>=3+ --minimum-percent <0..100> <aggregate.json>")
		return 2
	}
	secretData, err := os.ReadFile(resolveCallerPath(*secretPath)) // #nosec G304 -- explicit CLI input.
	if err != nil {
		fmt.Fprintf(os.Stderr, "read secret key: %v\n", err)
		return 1
	}
	secret, err := parseFHESecretKey(secretData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse secret key: %v\n", err)
		return 1
	}
	aggregateData, err := os.ReadFile(resolveCallerPath(flags.Arg(0))) // #nosec G304 -- explicit CLI input.
	if err != nil {
		fmt.Fprintf(os.Stderr, "read encrypted aggregate: %v\n", err)
		return 1
	}
	aggregate, err := parseEncryptedAggregate(aggregateData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse encrypted aggregate: %v\n", err)
		return 1
	}
	result, err := decryptAggregate(secret, *context, aggregate)
	if err != nil {
		fmt.Fprintf(os.Stderr, "decrypt encrypted aggregate: %v\n", err)
		return 1
	}
	if result.Repositories != *expected {
		fmt.Fprintf(os.Stderr, "expected %d repositories but the aggregate contains %d; refusing the result\n", *expected, result.Repositories)
		return 1
	}
	percentage := 100 * float64(result.PassedGates) / float64(result.TotalGates)
	if percentage >= *minimum {
		fmt.Printf("FLEET TARGET MET: %d of %d gates passed across %d repositories (%.1f%%, required %.1f%%)\n", result.PassedGates, result.TotalGates, result.Repositories, percentage, *minimum)
		return 0
	}
	fmt.Printf("FLEET TARGET NOT MET: %d of %d gates passed across %d repositories (%.1f%%, required %.1f%%)\n", result.PassedGates, result.TotalGates, result.Repositories, percentage, *minimum)
	return 3
}

func readFHEPublic(path string) (publicKeyFile, error) {
	data, err := os.ReadFile(resolveCallerPath(path)) // #nosec G304 -- explicit CLI input.
	if err != nil {
		return publicKeyFile{}, fmt.Errorf("read public key: %w", err)
	}
	public, err := parseFHEPublicKey(data)
	if err != nil {
		return publicKeyFile{}, fmt.Errorf("parse public key: %w", err)
	}
	return public, nil
}

func resolveCallerPath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if caller := strings.TrimSpace(os.Getenv("SKILLGATE_FHE_CALLER_CWD")); caller != "" {
		return filepath.Join(caller, path)
	}
	return path
}

func writeFHEExclusive(path string, data []byte, mode os.FileMode) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("output path must not be empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode) // #nosec G304 -- explicit CLI output.
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func ensureSecretIgnored() error {
	base := strings.TrimSpace(os.Getenv("SKILLGATE_FHE_CALLER_CWD"))
	if base == "" {
		base = "."
	}
	path := filepath.Join(base, ".gitignore")
	const entry = ".skillgate/fhe-metrics-secret.json"
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == entry {
			return nil
		}
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, []byte(entry+"\n")...)
	return os.WriteFile(path, data, 0o644)
}
