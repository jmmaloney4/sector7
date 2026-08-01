// Command pulumi-resource-sector7 is the sector7 Pulumi resource provider.
//
// The binary name is load-bearing: the Pulumi CLI discovers a plugin as
// pulumi-resource-<package> under $PULUMI_HOME/plugins/resource-<package>-v<ver>/.
package main

import (
	"context"
	"fmt"
	"os"

	p "github.com/pulumi/pulumi-go-provider"

	sector7 "github.com/jmmaloney4/sector7/provider"
	"github.com/jmmaloney4/sector7/provider/version"
)

func main() {
	prov, err := sector7.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "sector7: building provider: %v\n", err)
		os.Exit(1)
	}
	if err := p.RunProvider(context.Background(), sector7.Name, version.Version, prov); err != nil {
		fmt.Fprintf(os.Stderr, "sector7: %v\n", err)
		os.Exit(1)
	}
}
