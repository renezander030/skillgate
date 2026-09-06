package main

import (
	"fmt"
	"strings"
	"testing"
)

func report(passed ...bool) []byte {
	results := ""
	all := true
	for i, ok := range passed {
		if i > 0 {
			results += ","
		}
		results += fmt.Sprintf(`{"id":"gate-%d","ok":%t,"reason":"private detail"}`, i, ok)
		all = all && ok
	}
	return []byte(fmt.Sprintf(`{"passed":%t,"results":[%s],"failed":[]}`, all, results))
}

func TestFleetMetricsAggregateWithoutReadableCounts(t *testing.T) {
	secret, public, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	context := "2026-Q3-policy-a"
	reports := [][]byte{report(true, true), report(true, false, true), report(true)}
	metrics := make([]encryptedMetric, 0, len(reports))
	for i, source := range reports {
		metric, err := encryptCheckReport(public, context, fmt.Sprintf("random-repo-token-%d", i), source)
		if err != nil {
			t.Fatalf("encrypt report %d: %v", i, err)
		}
		encoded, err := marshalFHE(metric)
		if err != nil {
			t.Fatal(err)
		}
		for _, private := range []string{context, "private detail", "gate-", `"passed":`, `"results":`} {
			if strings.Contains(string(encoded), private) {
				t.Fatalf("encrypted metric disclosed %q", private)
			}
		}
		metrics = append(metrics, metric)
	}
	aggregate, err := aggregateMetrics(public, context, metrics)
	if err != nil {
		t.Fatal(err)
	}
	result, err := decryptAggregate(secret, context, aggregate)
	if err != nil {
		t.Fatal(err)
	}
	if result.PassedGates != 5 || result.TotalGates != 6 || result.Repositories != 3 {
		t.Fatalf("unexpected fleet result: %+v", result)
	}
}

func TestMetricRejectsInconsistentReport(t *testing.T) {
	_, public, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	_, err = encryptCheckReport(public, "quarter", "repo", []byte(`{"passed":true,"results":[{"ok":false}]}`))
	if err == nil || !strings.Contains(err.Error(), "inconsistent") {
		t.Fatalf("wanted inconsistent-report rejection, got %v", err)
	}
}

func TestAggregateRejectsWrongContextKeyAndDuplicateRepository(t *testing.T) {
	_, public, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	_, otherPublic, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	metrics := make([]encryptedMetric, 0, 3)
	for i := 0; i < 3; i++ {
		metric, err := encryptCheckReport(public, "quarter", fmt.Sprintf("repo-%d", i), report(true))
		if err != nil {
			t.Fatal(err)
		}
		metrics = append(metrics, metric)
	}
	if _, err := aggregateMetrics(public, "other-quarter", metrics); err == nil || !strings.Contains(err.Error(), "context") {
		t.Fatalf("wanted context rejection, got %v", err)
	}
	if _, err := aggregateMetrics(otherPublic, "quarter", metrics); err == nil || !strings.Contains(err.Error(), "key ID") {
		t.Fatalf("wanted key rejection, got %v", err)
	}
	if _, err := aggregateMetrics(public, "quarter", []encryptedMetric{metrics[0], metrics[0], metrics[2]}); err == nil || !strings.Contains(err.Error(), "repeats repository commitment") {
		t.Fatalf("wanted duplicate rejection, got %v", err)
	}
	if _, err := aggregateMetrics(public, "quarter", metrics[:2]); err == nil || !strings.Contains(err.Error(), "at least 3") {
		t.Fatalf("wanted small-group rejection, got %v", err)
	}
}

func TestDecryptRejectsPartialMetadataAndWrongContext(t *testing.T) {
	secret, public, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	metrics := make([]encryptedMetric, 0, 3)
	for i := 0; i < 3; i++ {
		metric, err := encryptCheckReport(public, "release", fmt.Sprintf("repo-%d", i), report(true, false))
		if err != nil {
			t.Fatal(err)
		}
		metrics = append(metrics, metric)
	}
	aggregate, err := aggregateMetrics(public, "release", metrics)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptAggregate(secret, "different", aggregate); err == nil || !strings.Contains(err.Error(), "context") {
		t.Fatalf("wanted context rejection, got %v", err)
	}
	bad := aggregate
	bad.Repositories++
	if _, err := decryptAggregate(secret, "release", bad); err == nil || !strings.Contains(err.Error(), "repository count") {
		t.Fatalf("wanted repository-count rejection, got %v", err)
	}
	writtenCount := aggregate
	writtenCount.Repositories++
	writtenCount.Contributors = append(writtenCount.Contributors, strings.Repeat("0", 64))
	if _, err := decryptAggregate(secret, "release", writtenCount); err == nil || !strings.Contains(err.Error(), "encrypted repository count") {
		t.Fatalf("wanted encrypted-count rejection, got %v", err)
	}
}

func TestStrictJSONRejectsUnknownFields(t *testing.T) {
	if _, err := parseEncryptedMetric([]byte(`{"schema":"x","extra":true}`)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("wanted unknown-field rejection, got %v", err)
	}
}

func TestMetricRejectsMissingVerdicts(t *testing.T) {
	_, public, err := generateFHEKeys()
	if err != nil {
		t.Fatal(err)
	}
	for _, malformed := range [][]byte{
		[]byte(`{"results":[{"ok":true}]}`),
		[]byte(`{"passed":false,"results":[{}]}`),
	} {
		if _, err := encryptCheckReport(public, "quarter", "repo", malformed); err == nil || !strings.Contains(err.Error(), "verdict") {
			t.Fatalf("wanted missing-verdict rejection, got %v", err)
		}
	}
}
